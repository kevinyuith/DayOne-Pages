-- One rule for several platforms (data). Runs AFTER the delivery server that
-- understands sub11_in (rules.php, 10/10): an older server would read the key as
-- unknown and the rule would stop matching.
--
-- 1. Every rule's platform condition becomes the platform scope: `sub11` and a
--    `query.sub11 {equals}` turn into `sub11_in` (lowercase; the match no
--    longer depends on the case — "sub11 equals Taboola" used to let
--    sub11=taboola through).
-- 2. The active Suspicious rules that are one condition copied per platform
--    (webdriver, automation, iframe, no JS, no cookies, mobile without touch,
--    timezone mismatch) become one rule each: the copy with the lowest position
--    keeps its id and place, takes the family's name, the union of the
--    platforms and of the tags; the others are deleted.
-- 3. pages.rule_aliases remembers each deleted copy (its id and name) → the
--    rule that took it in: its hits are re-pointed (hits.rule_id) and the
--    rollups read its old rule_matches entries as the merged rule.
-- 4. The rollups are rebuilt from scratch by the backfill job.

CREATE TABLE IF NOT EXISTS pages.rule_aliases (
  old_id uuid PRIMARY KEY,
  old_name text NOT NULL,
  rule_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pages.rule_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.rule_aliases FROM public, anon, authenticated;
GRANT SELECT ON pages.rule_aliases TO service_role;
COMMENT ON TABLE pages.rule_aliases IS
  'A rule merged into another (20261010f): its old id and name map to the rule that took it in, for the hits and rule_matches it left.';

-- rule_match_rows: an entry of a merged copy (by id, or by its old name) counts as the merged rule.
CREATE OR REPLACE FUNCTION pages.rule_match_rows(p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(hit_id bigint, hour timestamptz, platform text, rule_id uuid, monitor boolean, passed boolean, loaded boolean, interacted boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH names AS (
    SELECT r.name, (array_agg(r.id))[1] AS id
    FROM pages.rules r
    GROUP BY r.name
    HAVING count(*) = 1
  )
  SELECT DISTINCT ON (h.id, rid.rule_id)
         h.id, date_trunc('hour', h.created_at), coalesce(h.platform, ''), rid.rule_id,
         coalesce(e ->> 'monitor', '') = 'true',
         (h.rule IS NULL AND h.decision = 'SERVE · GATE' AND h.status_code = 200),
         h.loaded_at IS NOT NULL,
         h.interacted_at IS NOT NULL
  FROM pages.hits h
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(h.rule_matches) = 'array' THEN h.rule_matches ELSE '[]'::jsonb END) e
  CROSS JOIN LATERAL (
    SELECT CASE WHEN e ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (e ->> 'id')::uuid END AS id
  ) eid
  LEFT JOIN pages.rule_aliases ai ON ai.old_id = eid.id
  LEFT JOIN pages.rule_aliases an ON eid.id IS NULL AND an.old_name = e ->> 'name'
  LEFT JOIN names n ON n.name = e ->> 'name'
  CROSS JOIN LATERAL (
    SELECT coalesce(ai.rule_id, eid.id, an.rule_id, n.id, '00000000-0000-0000-0000-000000000000'::uuid) AS rule_id
  ) rid
  WHERE h.created_at >= p_from AND h.created_at < p_to
    AND h.outcome <> 'redirect'
    AND h.rule_matches IS NOT NULL;
$function$;

-- hit_rule_id: a hit that still names a merged copy (a spooled hit written late) gets the merged rule.
CREATE OR REPLACE FUNCTION pages.hit_rule_id(p_name text, p_label text, p_reason text, p_tags jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_ids uuid[];
BEGIN
  IF p_name IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(r.id) INTO v_ids FROM pages.rules r WHERE r.name = p_name;
  IF cardinality(v_ids) > 1 THEN
    SELECT array_agg(r.id) INTO v_ids
    FROM pages.rules r
    WHERE r.name = p_name
      AND r.label = p_label
      AND nullif(left(btrim(r.reason), 200), '') IS NOT DISTINCT FROM p_reason
      AND r.tags = coalesce(p_tags, '[]'::jsonb);
  END IF;
  IF v_ids IS NULL THEN
    SELECT array_agg(a.rule_id) INTO v_ids FROM pages.rule_aliases a WHERE a.old_name = p_name;
  END IF;
  RETURN CASE WHEN cardinality(v_ids) = 1 THEN v_ids[1] END;
END $function$;

DO $migration$
DECLARE
  v_fam record;
  v_survivor uuid;
  v_others uuid[];
  v_name text;
  v_before integer := (SELECT count(*) FROM pages.rules);
  v_repointed bigint := 0;
  v_n bigint;
BEGIN
  -- 1. sub11 / query.sub11 equals → sub11_in.
  UPDATE pages.rules r
  SET conditions = x.c
  FROM (
    SELECT r2.id,
           (CASE WHEN q.rest = '{}'::jsonb OR q.rest IS NULL THEN r2.conditions - 'sub11' - 'query'
                 ELSE jsonb_set(r2.conditions - 'sub11', '{query}', q.rest) END)
           || jsonb_build_object('sub11_in', (
                SELECT jsonb_agg(DISTINCT p ORDER BY p)
                FROM unnest(array_remove(array[
                       lower(btrim(r2.conditions ->> 'sub11')),
                       lower(btrim(r2.conditions -> 'query' -> 'sub11' ->> 'equals'))
                     ] || coalesce(ARRAY(SELECT jsonb_array_elements_text(r2.conditions -> 'sub11_in')), '{}'), NULL)) AS p
              )) AS c
    FROM pages.rules r2
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r2.conditions ? 'query'
                  THEN CASE WHEN jsonb_typeof(r2.conditions -> 'query' -> 'sub11') = 'object' THEN (r2.conditions -> 'query') - 'sub11'
                            ELSE r2.conditions -> 'query' END END AS rest
    ) q
    WHERE r2.conditions ? 'sub11'
       OR jsonb_typeof(r2.conditions -> 'query' -> 'sub11') = 'object'
  ) x
  WHERE r.id = x.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'platform scope: % rules converted', v_n;

  -- 2. The families: active Suspicious rules, one platform each, the same conditions otherwise.
  FOR v_fam IN
    SELECT r.label, r.conditions - 'sub11_in' AS base,
           array_agg(r.id ORDER BY r.position, r.created_at) AS ids
    FROM pages.rules r
    WHERE r.is_active AND NOT r.is_monitor
      AND lower(r.label) = 'suspicious'
      AND jsonb_array_length(coalesce(r.conditions -> 'sub11_in', '[]'::jsonb)) = 1
      AND (r.conditions - 'sub11_in') IN (
        '{"webdriver": 1}', '{"automation": 1}', '{"iframe": 1}', '{"no_js": 1}', '{"no_cookie": 1}',
        '{"devices": ["mobile"], "no_touch": 1}', '{"tz_mismatch": 1}')
    GROUP BY r.label, r.conditions - 'sub11_in'
    HAVING count(*) > 1
  LOOP
    v_survivor := v_fam.ids[1];
    v_others := v_fam.ids[2:];
    v_name := CASE v_fam.base
      WHEN '{"webdriver": 1}'::jsonb THEN 'Webdriver'
      WHEN '{"automation": 1}'::jsonb THEN 'Automation'
      WHEN '{"iframe": 1}'::jsonb THEN 'In iframe'
      WHEN '{"no_js": 1}'::jsonb THEN 'No JavaScript'
      WHEN '{"no_cookie": 1}'::jsonb THEN 'No cookies'
      WHEN '{"devices": ["mobile"], "no_touch": 1}'::jsonb THEN 'Mobile, no touch'
      WHEN '{"tz_mismatch": 1}'::jsonb THEN 'Timezone mismatch'
    END;

    INSERT INTO pages.rule_aliases (old_id, old_name, rule_id)
    SELECT r.id, r.name, v_survivor FROM pages.rules r WHERE r.id = ANY (v_fam.ids)
    ON CONFLICT (old_id) DO UPDATE SET rule_id = excluded.rule_id;

    UPDATE pages.rules r
    SET name = v_name,
        conditions = v_fam.base || jsonb_build_object('sub11_in', (
          SELECT jsonb_agg(DISTINCT p ORDER BY p)
          FROM pages.rules m CROSS JOIN LATERAL jsonb_array_elements_text(m.conditions -> 'sub11_in') p
          WHERE m.id = ANY (v_fam.ids))),
        tags = (
          SELECT coalesce(jsonb_agg(t ORDER BY t), '[]'::jsonb)
          FROM (SELECT DISTINCT t FROM pages.rules m CROSS JOIN LATERAL jsonb_array_elements_text(m.tags) t WHERE m.id = ANY (v_fam.ids)) d)
    WHERE r.id = v_survivor;

    UPDATE pages.hits h SET rule_id = v_survivor WHERE h.rule_id = ANY (v_others);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_repointed := v_repointed + v_n;

    DELETE FROM pages.rules r WHERE r.id = ANY (v_others);
    RAISE NOTICE 'merged % rules into "%" (%)', cardinality(v_fam.ids), v_name, v_survivor;
  END LOOP;

  RAISE NOTICE 'rules: % → %; hits re-pointed: %', v_before, (SELECT count(*) FROM pages.rules), v_repointed;

  -- 4. Rebuild the rollups (the backfill job re-rolls every hour, newest first).
  DELETE FROM pages.rollup_hours;
  IF NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'pages-rule-rollup-backfill') THEN
    PERFORM cron.schedule('pages-rule-rollup-backfill', '* * * * *',
      $job$SET statement_timeout = '300s'; SELECT pages.rule_rollup_backfill(12)$job$);
  END IF;
END $migration$;
