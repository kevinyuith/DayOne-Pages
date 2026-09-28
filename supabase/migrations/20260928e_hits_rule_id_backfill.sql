-- ============================================================================
-- DayOne Pages — every hit caught by a rule has its rule_id; Logs by rule
--
-- The hits logged before 20260928c get their rule_id the same way the trigger
-- gives it (hit_rule_id: the only rule with the name, else the only one with
-- the same name, label, reason and tags). In production this ran before, in
-- id ranges (short transactions: the beacon's updates wait on the rows being
-- written), and the index was built CONCURRENTLY; here both are no-ops there.
-- The hits of rules deleted before (no id left) stay NULL.
--
-- With every hit attributed, rule_stats groups by rule_id and no longer
-- attributes at read time. The Rules screen's numbers link to the Logs filtered
-- by the rule (rule_id), newest first: idx_pages_hits_rule.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

WITH r AS (
  SELECT id, name, label, nullif(left(btrim(reason), 200), '') AS reason, tags,
         count(*) OVER (PARTITION BY name) = 1 AS by_name
  FROM pages.rules
), fp AS (
  SELECT id, name, label, reason, tags, by_name
  FROM (SELECT r.*, count(*) OVER (PARTITION BY name, label, reason, tags) AS same FROM r) x
  WHERE by_name OR same = 1
)
UPDATE pages.hits h
SET rule_id = fp.id
FROM fp
WHERE h.rule IS NOT NULL
  AND h.rule_id IS NULL
  AND fp.name = h.rule
  AND (fp.by_name OR (fp.label = h.rule_label AND fp.reason IS NOT DISTINCT FROM h.rule_reason AND fp.tags = coalesce(h.rule_tags, '[]'::jsonb)));

CREATE INDEX IF NOT EXISTS idx_pages_hits_rule ON pages.hits (rule_id, id DESC) WHERE rule_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pages.rule_stats(p_since timestamptz)
RETURNS TABLE(rule_id uuid, hits bigint, uniques bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  -- One row per (rule, IP) first: distinct IPs without sorting every hit. rule_id NULL = Passed.
  WITH per_ip AS (
    SELECT h.rule_id, h.ip, count(*) AS n
    FROM pages.hits h
    WHERE h.created_at >= p_since
      AND h.outcome <> 'redirect'
      AND (h.rule_id IS NOT NULL OR (h.rule IS NULL AND h.decision = 'SERVE · GATE' AND h.status_code = 200))
    GROUP BY 1, 2
  )
  SELECT rule_id, sum(n)::bigint, count(ip)
  FROM per_ip
  GROUP BY rule_id;
$function$;

NOTIFY pgrst, 'reload schema';
