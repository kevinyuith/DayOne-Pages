-- ============================================================================
-- DayOne Pages — the Dashboard's Traffic chart: Bots, Suspicious, Passed, Loaded
--
-- hit_series draws the same four unique counts as the cards, per bucket:
-- distinct IPs a rule labeled Bot (is_bot) or Suspicious, the ones that passed
-- the gate (a funnel page served by the gate, 'SERVE · GATE' with a 200) and,
-- of those, the ones whose page loaded. Distinct counts don't add up across
-- buckets (one visitor in two hours is one, not two), so the buckets are given
-- by their EDGES, not by a size: p_edges are instants (the frontend's New York
-- hours or midnights — this function knows no time zone), and bucket i counts
-- the hits in [edges[i], edges[i+1]); it's returned as edges[i]. Up to 1000
-- edges; they are sorted and deduplicated here. The dashboard filters apply as
-- in hit_stats. The old hit_timeseries (requests, summed per day) stays for a
-- dashboard still on the old code.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.hit_series(
  p_edges     timestamptz[],
  p_domain    uuid    DEFAULT NULL,
  p_outcomes  text[]  DEFAULT NULL,
  p_devices   text[]  DEFAULT NULL,
  p_countries text[]  DEFAULT NULL,
  p_hide_bots boolean DEFAULT false
)
RETURNS TABLE(bucket timestamptz, bots bigint, suspicious bigint, passed bigint, loaded bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH e AS (
    SELECT array_agg(t ORDER BY t) AS edges
    FROM (SELECT DISTINCT unnest(p_edges) AS t) s
    WHERE t IS NOT NULL
  ),
  ok AS (
    SELECT edges FROM e WHERE cardinality(edges) BETWEEN 2 AND 1000
  ),
  agg AS (
    SELECT width_bucket(h.created_at, ok.edges) AS i,
      count(DISTINCT h.ip) FILTER (WHERE h.is_bot)                                          AS bots,
      count(DISTINCT h.ip) FILTER (WHERE h.rule_label = 'Suspicious')                       AS suspicious,
      count(DISTINCT h.ip) FILTER (WHERE h.decision = 'SERVE · GATE' AND h.status_code = 200) AS passed,
      count(DISTINCT h.ip) FILTER (WHERE h.decision = 'SERVE · GATE' AND h.status_code = 200 AND h.loaded_at IS NOT NULL) AS loaded
    FROM pages.hits h, ok
    WHERE h.created_at >= ok.edges[1] AND h.created_at < ok.edges[cardinality(ok.edges)]
      AND (p_domain IS NULL OR h.domain_id = p_domain)
      AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR h.outcome = ANY (p_outcomes))
      AND (coalesce(cardinality(p_devices), 0)   = 0 OR h.device  = ANY (p_devices))
      AND (coalesce(cardinality(p_countries), 0) = 0 OR h.country = ANY (p_countries))
      AND (NOT coalesce(p_hide_bots, false) OR NOT h.is_bot)
    GROUP BY 1
  )
  SELECT ok.edges[g.i], coalesce(a.bots, 0), coalesce(a.suspicious, 0), coalesce(a.passed, 0), coalesce(a.loaded, 0)
  FROM ok
  CROSS JOIN LATERAL generate_series(1, cardinality(ok.edges) - 1) AS g(i)
  LEFT JOIN agg a ON a.i = g.i
  ORDER BY g.i;
$function$;

-- Like the other Dashboard functions: the service role only.
REVOKE ALL ON FUNCTION pages.hit_series(timestamptz[], uuid, text[], text[], text[], boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.hit_series(timestamptz[], uuid, text[], text[], text[], boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
