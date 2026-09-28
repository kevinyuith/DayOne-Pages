-- ============================================================================
-- DayOne Pages — rule_stats in one pass
--
-- 20260928c read the period twice (a CTE used by two branches) and called
-- hit_rule_id per fingerprint inside the query. Now the hits are grouped per
-- (rule, IP) in one scan and only those groups are attributed, by a join with
-- the rules told apart the same way hit_rule_id does it: by the name when no
-- other rule has it, else by the name, label, reason and tags when no other
-- rule has all four (rules nothing tells apart get no hits). Same result.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.rule_stats(p_since timestamptz)
RETURNS TABLE(rule_id uuid, hits bigint, uniques bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH g AS (
    SELECT h.rule_id, h.rule, h.rule_label, h.rule_reason, h.rule_tags, h.ip, count(*) AS n
    FROM pages.hits h
    WHERE h.created_at >= p_since
      AND h.outcome <> 'redirect'
      AND (h.rule IS NOT NULL OR (h.decision = 'SERVE · GATE' AND h.status_code = 200))
    GROUP BY 1, 2, 3, 4, 5, 6
  ),
  r AS (
    SELECT id, name, label, nullif(left(btrim(reason), 200), '') AS reason, tags,
           count(*) OVER (PARTITION BY name) = 1 AS by_name
    FROM pages.rules
  ),
  fp AS (
    SELECT id, name, label, reason, tags, by_name
    FROM (SELECT r.*, count(*) OVER (PARTITION BY name, label, reason, tags) AS same FROM r) x
    WHERE by_name OR same = 1
  ),
  -- Per rule and IP again: a hit from before rule_id and a newer one of the same IP are one visitor.
  per_ip AS (
    SELECT g.rule IS NULL AS passed, coalesce(g.rule_id, fp.id) AS rule_id, g.ip, sum(g.n) AS n
    FROM g
    LEFT JOIN fp
      ON g.rule_id IS NULL
     AND fp.name = g.rule
     AND (fp.by_name OR (fp.label = g.rule_label AND fp.reason IS NOT DISTINCT FROM g.rule_reason AND fp.tags = coalesce(g.rule_tags, '[]'::jsonb)))
    GROUP BY 1, 2, 3
  )
  SELECT CASE WHEN passed THEN NULL ELSE rule_id END, sum(n)::bigint, count(ip)
  FROM per_ip
  WHERE passed OR rule_id IS NOT NULL
  GROUP BY passed, rule_id;
$function$;

NOTIFY pgrst, 'reload schema';
