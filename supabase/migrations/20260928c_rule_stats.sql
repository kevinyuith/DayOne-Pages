-- ============================================================================
-- DayOne Pages — how many clicks each rule caught, and the Logs' Platform filter
--
-- A hit named its rule only by text (rule, rule_label, rule_reason, rule_tags:
-- what the server logs), and two rules may share a name. pages.hits.rule_id
-- (no FK: the rule may be deleted later) is now filled on insert by a trigger
-- (hits_set_rule, so any server's log_hit gets it): the only rule with that
-- name, or — when several share it — the only one whose label, reason and tags
-- are the hit's too; NULL when that still leaves more than one. It is recorded
-- when the click happens, so renaming or editing the rule later keeps its
-- numbers. The hits logged before get the same attribution at read time
-- (hits aren't rewritten: a backfill would rewrite most of the table).
--
-- rule_stats(p_since) gives the Rules screen its numbers for the period: per
-- rule, the clicks it caught and the distinct IPs; and the Passed row
-- (rule_id NULL) — the clicks that passed the gate, a funnel page served by it
-- with a 200, as the Dashboard counts them. The www entry redirect isn't
-- counted (the same click comes right back on the bare domain).
--
-- The Logs' Platform filter reads the hits of one platform newest first; the
-- partial index keeps that and the filter's options (hit_platforms) off a scan
-- of the whole table.
-- ============================================================================

-- pages.hits takes a write every click: give up rather than queue the inserts behind a long read.
SET LOCAL lock_timeout = '5s';

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS rule_id uuid;

COMMENT ON COLUMN pages.hits.rule_id IS 'The rule that caught the click (pages.rules.id, no FK), filled on insert from the rule''s name, label, reason and tags (hits_set_rule). NULL = no rule, or one that couldn''t be told apart.';

-- The rule a hit names: the only one with the name, else the only one with the
-- name, label, reason and tags as the server logs them (reason: trimmed, '' = NULL).
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
  RETURN CASE WHEN cardinality(v_ids) = 1 THEN v_ids[1] END;
END $function$;

REVOKE ALL ON FUNCTION pages.hit_rule_id(text, text, text, jsonb) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION pages.hits_set_rule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.rule IS NOT NULL AND NEW.rule_id IS NULL THEN
    NEW.rule_id := pages.hit_rule_id(NEW.rule, NEW.rule_label, NEW.rule_reason, NEW.rule_tags);
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS hits_set_rule ON pages.hits;
CREATE TRIGGER hits_set_rule BEFORE INSERT ON pages.hits
  FOR EACH ROW EXECUTE FUNCTION pages.hits_set_rule();

-- ── rule_stats ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.rule_stats(p_since timestamptz)
RETURNS TABLE(rule_id uuid, hits bigint, uniques bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH h AS (
    SELECT h.rule_id, h.rule, h.rule_label, h.rule_reason, h.rule_tags, h.ip
    FROM pages.hits h
    WHERE h.created_at >= p_since
      AND h.outcome <> 'redirect'
      AND (h.rule IS NOT NULL OR (h.decision = 'SERVE · GATE' AND h.status_code = 200))
  ),
  -- Hits from before rule_id: few distinct fingerprints, each attributed once.
  old AS (
    SELECT o.*, pages.hit_rule_id(o.rule, o.rule_label, o.rule_reason, o.rule_tags) AS id
    FROM (SELECT DISTINCT rule, rule_label, rule_reason, rule_tags FROM h WHERE rule IS NOT NULL AND rule_id IS NULL) o
  ),
  keyed AS (
    SELECT CASE WHEN h.rule IS NULL THEN NULL ELSE coalesce(h.rule_id, old.id) END AS rule_id,
           h.rule IS NULL AS passed, h.ip
    FROM h
    LEFT JOIN old
      ON h.rule_id IS NULL
     AND old.rule = h.rule
     AND old.rule_label IS NOT DISTINCT FROM h.rule_label
     AND old.rule_reason IS NOT DISTINCT FROM h.rule_reason
     AND old.rule_tags IS NOT DISTINCT FROM h.rule_tags
  ),
  -- One row per (rule, IP) first: distinct IPs without sorting every hit.
  per_ip AS (
    SELECT rule_id, ip, count(*) AS n
    FROM keyed
    WHERE passed OR rule_id IS NOT NULL
    GROUP BY rule_id, ip
  )
  SELECT rule_id, sum(n)::bigint AS hits, count(ip) AS uniques
  FROM per_ip
  GROUP BY rule_id;
$function$;

REVOKE ALL ON FUNCTION pages.rule_stats(timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rule_stats(timestamptz) TO service_role;

-- ── The Logs' Platform filter ───────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pages_hits_platform ON pages.hits (platform, id DESC)
  INCLUDE (created_at, domain_id)
  WHERE platform IS NOT NULL;

NOTIFY pgrst, 'reload schema';
