-- Hourly rollups of the Rules screen's numbers.
--
-- The screen used to count straight from pages.hits (~1M rows a day): 7 days took
-- 20–60 s. Now three small tables hold, per UTC hour:
--
--   rule_hourly       per rule and platform (coalesce(hits.platform, '')):
--                       blocked             hits the rule served the safe page for (hits.rule_id), as rule_stats counts them
--                       matched / alone     hits whose rule_matches has the rule (not in Monitor) / has only it
--                       monitor_passed      hits a Monitor rule matched that passed the gate (it would have blocked them),
--                       monitor_loaded        and of those the ones that loaded / where somebody interacted
--                       monitor_interacted
--   rule_pair_hourly  how many hits two rules (not in Monitor) both matched (rule_a < rule_b)
--   gate_hourly       per platform: hits caught by a Bot / Suspicious rule, and the clicks that passed
--                     (SERVE · GATE with a 200, as the Dashboard counts them), loaded and interacted
--
-- A rule_matches entry names its rule by `id` (servers since 20261010c) or, on
-- older hits, only by name: the only rule with that name, else the nil uuid.
-- The www entry redirect is never counted (the same click comes back on the bare domain).
--
-- pages.rule_rollup(from, to) re-aggregates whole hours (delete + insert) and
-- marks them in rollup_hours. pg_cron re-rolls the last 2 complete hours every
-- 10 minutes (the beacon's loaded/interacted land within minutes) and the last
-- 48 hours once a day (log_replay can write a hit up to a day late). The read
-- functions add the hours after the last rolled one straight from pages.hits.

CREATE TABLE IF NOT EXISTS pages.rule_hourly (
  hour timestamptz NOT NULL,
  rule_id uuid NOT NULL,
  platform text NOT NULL DEFAULT '',
  blocked integer NOT NULL DEFAULT 0,
  matched integer NOT NULL DEFAULT 0,
  alone integer NOT NULL DEFAULT 0,
  monitor_passed integer NOT NULL DEFAULT 0,
  monitor_loaded integer NOT NULL DEFAULT 0,
  monitor_interacted integer NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, rule_id, platform)
);

CREATE TABLE IF NOT EXISTS pages.rule_pair_hourly (
  hour timestamptz NOT NULL,
  rule_a uuid NOT NULL,
  rule_b uuid NOT NULL,
  platform text NOT NULL DEFAULT '',
  n integer NOT NULL,
  PRIMARY KEY (hour, rule_a, rule_b, platform)
);

CREATE TABLE IF NOT EXISTS pages.gate_hourly (
  hour timestamptz NOT NULL,
  platform text NOT NULL DEFAULT '',
  bot integer NOT NULL DEFAULT 0,
  suspicious integer NOT NULL DEFAULT 0,
  passed integer NOT NULL DEFAULT 0,
  loaded integer NOT NULL DEFAULT 0,
  interacted integer NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, platform)
);

CREATE TABLE IF NOT EXISTS pages.rollup_hours (
  hour timestamptz PRIMARY KEY,
  rolled_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pages.rule_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages.rule_pair_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages.gate_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages.rollup_hours ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.rule_hourly, pages.rule_pair_hourly, pages.gate_hourly, pages.rollup_hours FROM public, anon, authenticated;
GRANT SELECT ON pages.rule_hourly, pages.rule_pair_hourly, pages.gate_hourly, pages.rollup_hours TO service_role;

-- ── The aggregations (one range of whole hours; the rollup and the live tail) ──

-- One row per (hit, rule) of the hits' rule_matches in [from, to).
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
  LEFT JOIN names n ON n.name = e ->> 'name'
  CROSS JOIN LATERAL (
    SELECT coalesce(
             CASE WHEN e ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (e ->> 'id')::uuid END,
             n.id,
             '00000000-0000-0000-0000-000000000000'::uuid) AS rule_id
  ) rid
  WHERE h.created_at >= p_from AND h.created_at < p_to
    AND h.outcome <> 'redirect'
    AND h.rule_matches IS NOT NULL;
$function$;

CREATE OR REPLACE FUNCTION pages.rule_hourly_compute(p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(hour timestamptz, rule_id uuid, platform text, blocked bigint, matched bigint, alone bigint, monitor_passed bigint, monitor_loaded bigint, monitor_interacted bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH m AS (
    SELECT * FROM pages.rule_match_rows(p_from, p_to)
  ),
  per_hit AS (
    SELECT m.hit_id, count(*) FILTER (WHERE NOT m.monitor) AS n_active
    FROM m GROUP BY m.hit_id
  ),
  matched AS (
    SELECT m.hour, m.rule_id, m.platform,
           count(*) FILTER (WHERE NOT m.monitor) AS matched,
           count(*) FILTER (WHERE NOT m.monitor AND p.n_active = 1) AS alone,
           count(*) FILTER (WHERE m.monitor AND m.passed) AS monitor_passed,
           count(*) FILTER (WHERE m.monitor AND m.passed AND m.loaded) AS monitor_loaded,
           count(*) FILTER (WHERE m.monitor AND m.passed AND m.interacted) AS monitor_interacted
    FROM m JOIN per_hit p ON p.hit_id = m.hit_id
    GROUP BY 1, 2, 3
  ),
  blocked AS (
    SELECT date_trunc('hour', h.created_at) AS hour, h.rule_id, coalesce(h.platform, '') AS platform, count(*) AS blocked
    FROM pages.hits h
    WHERE h.created_at >= p_from AND h.created_at < p_to
      AND h.outcome <> 'redirect'
      AND h.rule_id IS NOT NULL
    GROUP BY 1, 2, 3
  )
  SELECT coalesce(b.hour, x.hour), coalesce(b.rule_id, x.rule_id), coalesce(b.platform, x.platform),
         coalesce(b.blocked, 0), coalesce(x.matched, 0), coalesce(x.alone, 0),
         coalesce(x.monitor_passed, 0), coalesce(x.monitor_loaded, 0), coalesce(x.monitor_interacted, 0)
  FROM blocked b
  FULL JOIN matched x ON x.hour = b.hour AND x.rule_id = b.rule_id AND x.platform = b.platform;
$function$;

CREATE OR REPLACE FUNCTION pages.rule_pair_hourly_compute(p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(hour timestamptz, rule_a uuid, rule_b uuid, platform text, n bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH m AS (
    SELECT * FROM pages.rule_match_rows(p_from, p_to) WHERE NOT monitor
  )
  SELECT a.hour, a.rule_id, b.rule_id, a.platform, count(*)
  FROM m a
  JOIN m b ON b.hit_id = a.hit_id AND a.rule_id < b.rule_id
  GROUP BY 1, 2, 3, 4;
$function$;

CREATE OR REPLACE FUNCTION pages.gate_hourly_compute(p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(hour timestamptz, platform text, bot bigint, suspicious bigint, passed bigint, loaded bigint, interacted bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT date_trunc('hour', h.created_at), coalesce(h.platform, ''),
         count(*) FILTER (WHERE h.rule IS NOT NULL AND lower(h.rule_label) = 'bot'),
         count(*) FILTER (WHERE h.rule IS NOT NULL AND lower(h.rule_label) = 'suspicious'),
         count(*) FILTER (WHERE h.rule IS NULL AND h.decision = 'SERVE · GATE' AND h.status_code = 200),
         count(*) FILTER (WHERE h.rule IS NULL AND h.decision = 'SERVE · GATE' AND h.status_code = 200 AND h.loaded_at IS NOT NULL),
         count(*) FILTER (WHERE h.rule IS NULL AND h.decision = 'SERVE · GATE' AND h.status_code = 200 AND h.interacted_at IS NOT NULL)
  FROM pages.hits h
  WHERE h.created_at >= p_from AND h.created_at < p_to
    AND h.outcome <> 'redirect'
    AND (h.rule IS NOT NULL OR (h.decision = 'SERVE · GATE' AND h.status_code = 200))
  GROUP BY 1, 2;
$function$;

-- ── The rollup ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.rule_rollup(p_from timestamptz, p_to timestamptz)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_h timestamptz := date_trunc('hour', p_from);
  v_to timestamptz := least(date_trunc('hour', p_to), date_trunc('hour', now()));
  v_n integer := 0;
BEGIN
  -- One run at a time (the 10-minute job, the daily one, the backfill).
  IF NOT pg_try_advisory_xact_lock(hashtext('pages.rule_rollup')) THEN
    RETURN 0;
  END IF;
  WHILE v_h < v_to LOOP
    DELETE FROM pages.rule_hourly r WHERE r.hour = v_h;
    DELETE FROM pages.rule_pair_hourly r WHERE r.hour = v_h;
    DELETE FROM pages.gate_hourly g WHERE g.hour = v_h;
    INSERT INTO pages.rule_hourly (hour, rule_id, platform, blocked, matched, alone, monitor_passed, monitor_loaded, monitor_interacted)
      SELECT * FROM pages.rule_hourly_compute(v_h, v_h + interval '1 hour');
    INSERT INTO pages.rule_pair_hourly (hour, rule_a, rule_b, platform, n)
      SELECT * FROM pages.rule_pair_hourly_compute(v_h, v_h + interval '1 hour');
    INSERT INTO pages.gate_hourly (hour, platform, bot, suspicious, passed, loaded, interacted)
      SELECT * FROM pages.gate_hourly_compute(v_h, v_h + interval '1 hour');
    INSERT INTO pages.rollup_hours (hour, rolled_at) VALUES (v_h, now())
      ON CONFLICT (hour) DO UPDATE SET rolled_at = excluded.rolled_at;
    v_h := v_h + interval '1 hour';
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $function$;

-- The hours never rolled (from the first hit on), newest first — the screen's
-- recent days fill in first —, p_hours at a time. The backfill job calls it
-- every minute and unschedules itself when nothing is left.
CREATE OR REPLACE FUNCTION pages.rule_rollup_backfill(p_hours integer DEFAULT 12)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_first timestamptz := (SELECT date_trunc('hour', min(h.created_at)) FROM pages.hits h);
  v_h timestamptz;
  v_n integer := 0;
BEGIN
  FOR v_h IN
    SELECT g.h
    FROM generate_series(v_first, date_trunc('hour', now()) - interval '1 hour', interval '1 hour') AS g(h)
    WHERE NOT EXISTS (SELECT 1 FROM pages.rollup_hours r WHERE r.hour = g.h)
    ORDER BY g.h DESC
    LIMIT greatest(p_hours, 1)
  LOOP
    v_n := v_n + pages.rule_rollup(v_h, v_h + interval '1 hour');
  END LOOP;
  -- Done only when no hour is missing (a run that found the lock taken rolled nothing, and that's not "done").
  IF NOT EXISTS (
       SELECT 1
       FROM generate_series(v_first, date_trunc('hour', now()) - interval '1 hour', interval '1 hour') AS g(h)
       WHERE NOT EXISTS (SELECT 1 FROM pages.rollup_hours r WHERE r.hour = g.h))
     AND EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'pages-rule-rollup-backfill') THEN
    PERFORM cron.unschedule('pages-rule-rollup-backfill');
  END IF;
  RETURN v_n;
END $function$;

REVOKE ALL ON FUNCTION pages.rule_match_rows(timestamptz, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_hourly_compute(timestamptz, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_pair_hourly_compute(timestamptz, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.gate_hourly_compute(timestamptz, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_rollup(timestamptz, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_rollup_backfill(integer) FROM public, anon, authenticated;

-- ── The screen's reads: rolled hours + the hours after the last rolled one, live ──

-- The first hour not rolled yet (rolled hours are contiguous at the end: the jobs re-roll the latest).
CREATE OR REPLACE FUNCTION pages.rollup_cut(p_since timestamptz)
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT greatest(
    coalesce((SELECT max(r.hour) + interval '1 hour' FROM pages.rollup_hours r), date_trunc('hour', p_since)),
    date_trunc('hour', p_since));
$function$;

-- Per rule and platform since p_since (from its hour).
CREATE OR REPLACE FUNCTION pages.rule_totals(p_since timestamptz)
 RETURNS TABLE(rule_id uuid, platform text, blocked bigint, matched bigint, alone bigint, monitor_passed bigint, monitor_loaded bigint, monitor_interacted bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH cut AS (SELECT pages.rollup_cut(p_since) AS at)
  SELECT x.rule_id, x.platform, sum(x.blocked)::bigint, sum(x.matched)::bigint, sum(x.alone)::bigint,
         sum(x.monitor_passed)::bigint, sum(x.monitor_loaded)::bigint, sum(x.monitor_interacted)::bigint
  FROM (
    SELECT r.rule_id, r.platform, r.blocked, r.matched, r.alone, r.monitor_passed, r.monitor_loaded, r.monitor_interacted
    FROM pages.rule_hourly r, cut
    WHERE r.hour >= date_trunc('hour', p_since) AND r.hour < cut.at
    UNION ALL
    SELECT c.rule_id, c.platform, c.blocked, c.matched, c.alone, c.monitor_passed, c.monitor_loaded, c.monitor_interacted
    FROM cut CROSS JOIN LATERAL pages.rule_hourly_compute(cut.at, now() + interval '1 hour') c
  ) x
  GROUP BY 1, 2;
$function$;

-- Per bucket of p_bounds (ascending instants — the frontend's local midnights:
-- bucket i = [p_bounds[i], p_bounds[i+1])) and rule: blocked, and what a Monitor rule would have blocked.
CREATE OR REPLACE FUNCTION pages.rule_buckets(p_bounds timestamptz[])
 RETURNS TABLE(bucket integer, rule_id uuid, blocked bigint, monitor_passed bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH cut AS (SELECT pages.rollup_cut(p_bounds[1]) AS at),
  x AS (
    SELECT r.hour, r.rule_id, r.blocked, r.monitor_passed
    FROM pages.rule_hourly r, cut
    WHERE r.hour >= p_bounds[1] AND r.hour < cut.at
    UNION ALL
    SELECT c.hour, c.rule_id, c.blocked, c.monitor_passed
    FROM cut CROSS JOIN LATERAL pages.rule_hourly_compute(cut.at, now() + interval '1 hour') c
  )
  SELECT width_bucket(x.hour, p_bounds), x.rule_id, sum(x.blocked)::bigint, sum(x.monitor_passed)::bigint
  FROM x
  WHERE x.hour >= p_bounds[1] AND x.hour < p_bounds[cardinality(p_bounds)]
  GROUP BY 1, 2;
$function$;

-- Per platform since p_since: caught by Bot / Suspicious rules, passed, loaded, interacted.
CREATE OR REPLACE FUNCTION pages.gate_totals(p_since timestamptz)
 RETURNS TABLE(platform text, bot bigint, suspicious bigint, passed bigint, loaded bigint, interacted bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH cut AS (SELECT pages.rollup_cut(p_since) AS at)
  SELECT x.platform, sum(x.bot)::bigint, sum(x.suspicious)::bigint, sum(x.passed)::bigint, sum(x.loaded)::bigint, sum(x.interacted)::bigint
  FROM (
    SELECT g.platform, g.bot, g.suspicious, g.passed, g.loaded, g.interacted
    FROM pages.gate_hourly g, cut
    WHERE g.hour >= date_trunc('hour', p_since) AND g.hour < cut.at
    UNION ALL
    SELECT c.platform, c.bot, c.suspicious, c.passed, c.loaded, c.interacted
    FROM cut CROSS JOIN LATERAL pages.gate_hourly_compute(cut.at, now() + interval '1 hour') c
  ) x
  GROUP BY 1;
$function$;

-- How many hits two rules both matched since p_since, on one platform ('' = no platform) or all (NULL). Rolled hours only.
CREATE OR REPLACE FUNCTION pages.rule_pairs(p_since timestamptz, p_platform text DEFAULT NULL)
 RETURNS TABLE(rule_a uuid, rule_b uuid, n bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT p.rule_a, p.rule_b, sum(p.n)::bigint
  FROM pages.rule_pair_hourly p
  WHERE p.hour >= date_trunc('hour', p_since)
    AND (p_platform IS NULL OR p.platform = p_platform)
  GROUP BY 1, 2;
$function$;

REVOKE ALL ON FUNCTION pages.rollup_cut(timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_totals(timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_buckets(timestamptz[]) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.gate_totals(timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_pairs(timestamptz, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rule_totals(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION pages.rule_buckets(timestamptz[]) TO service_role;
GRANT EXECUTE ON FUNCTION pages.gate_totals(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION pages.rule_pairs(timestamptz, text) TO service_role;

-- ── The Logs' ?matched= on a Monitor rule: a small partial index of the hits a Monitor rule matched ──
-- Created CONCURRENTLY outside this migration (it runs in a transaction):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_hits_monitor ON pages.hits (id DESC)
--     WHERE rule_matches @? '$[*] ? (@.monitor == true)';

-- ── Jobs ─────────────────────────────────────────────────────────────────────

SELECT cron.schedule('pages-rule-rollup', '4-59/10 * * * *',
  $$SET statement_timeout = '300s'; SELECT pages.rule_rollup(now() - interval '2 hours', now())$$);
SELECT cron.schedule('pages-rule-rollup-48h', '55 9 * * *',
  $$SET statement_timeout = '900s'; SELECT pages.rule_rollup(now() - interval '48 hours', now())$$);
SELECT cron.schedule('pages-rule-rollup-backfill', '* * * * *',
  $$SET statement_timeout = '300s'; SELECT pages.rule_rollup_backfill(12)$$);
