-- ============================================================================
-- DayOne Pages — the Dashboard's Platform filter, from sub11
--
-- pages.hits.platform was left behind by the first traffic gate (platforms
-- matched by sub11, dropped in 20260925d) and nothing wrote it anymore. It is
-- now the click's sub11, lowercased (Facebook and facebook are one platform),
-- '+' read as a space, trimmed, up to 40 characters; NULL without a sub11 or
-- with an empty one. A BEFORE INSERT trigger fills it from the hit's query, so
-- any server's log_hit gets it (like is_unique), and the hits logged before
-- are backfilled here.
--
-- hit_stats, hit_series and recent_hits take p_platforms (empty = every hit,
-- like the other filters); hit_platforms lists the platforms with hits in the
-- period, for the filter's options (like hit_countries). The argument lists
-- change, so DROP then CREATE; the new parameter has a default, so a dashboard
-- still on the old code keeps working.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.hit_platform(p_query text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
  SELECT nullif(left(btrim(lower(replace(substring(p_query FROM '(?:^|&)sub11=([^&]*)'), '+', ' '))), 40), '');
$function$;

REVOKE ALL ON FUNCTION pages.hit_platform(text) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION pages.hits_set_platform()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  NEW.platform := pages.hit_platform(NEW.query);
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS hits_set_platform ON pages.hits;
CREATE TRIGGER hits_set_platform BEFORE INSERT ON pages.hits
  FOR EACH ROW EXECUTE FUNCTION pages.hits_set_platform();

UPDATE pages.hits
SET platform = pages.hit_platform(query)
WHERE query ~ '(^|&)sub11='
  AND platform IS DISTINCT FROM pages.hit_platform(query);

COMMENT ON COLUMN pages.hits.platform IS 'The click''s platform: its sub11, lowercased (hits_set_platform, on insert). NULL without a sub11.';

-- ── hit_stats ───────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean);

CREATE FUNCTION pages.hit_stats(p_since timestamptz, p_domain uuid DEFAULT NULL, p_outcomes text[] DEFAULT NULL,
                                p_devices text[] DEFAULT NULL, p_countries text[] DEFAULT NULL, p_hide_bots boolean DEFAULT false,
                                p_platforms text[] DEFAULT NULL)
RETURNS TABLE(total bigint, served bigint, blocked bigint, bots bigint, uniques bigint,
              bots_unique bigint, suspicious_unique bigint, gate_unique bigint, loaded_unique bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT
    count(*)                                                        AS total,
    count(*) FILTER (WHERE outcome = 'served')                      AS served,
    count(*) FILTER (WHERE outcome IN ('blocked','bot'))            AS blocked,
    count(*) FILTER (WHERE is_bot)                                  AS bots,
    count(DISTINCT ip) FILTER (WHERE status_code = 200)             AS uniques,
    count(DISTINCT ip) FILTER (WHERE is_bot)                        AS bots_unique,
    count(DISTINCT ip) FILTER (WHERE rule_label = 'Suspicious')     AS suspicious_unique,
    count(DISTINCT ip) FILTER (WHERE decision = 'SERVE · GATE' AND status_code = 200)                          AS gate_unique,
    count(DISTINCT ip) FILTER (WHERE decision = 'SERVE · GATE' AND status_code = 200 AND loaded_at IS NOT NULL) AS loaded_unique
  FROM pages.hits
  WHERE created_at >= p_since
    AND (p_domain IS NULL OR domain_id = p_domain)
    AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR outcome  = ANY (p_outcomes))
    AND (coalesce(cardinality(p_devices), 0)   = 0 OR device   = ANY (p_devices))
    AND (coalesce(cardinality(p_countries), 0) = 0 OR country  = ANY (p_countries))
    AND (coalesce(cardinality(p_platforms), 0) = 0 OR platform = ANY (p_platforms))
    AND (NOT coalesce(p_hide_bots, false) OR NOT is_bot);
$function$;

REVOKE ALL ON FUNCTION pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean, text[]) TO service_role;

-- ── hit_series ──────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.hit_series(timestamptz[], uuid, text[], text[], text[], boolean);

CREATE FUNCTION pages.hit_series(
  p_edges     timestamptz[],
  p_domain    uuid    DEFAULT NULL,
  p_outcomes  text[]  DEFAULT NULL,
  p_devices   text[]  DEFAULT NULL,
  p_countries text[]  DEFAULT NULL,
  p_hide_bots boolean DEFAULT false,
  p_platforms text[]  DEFAULT NULL
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
      AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR h.outcome  = ANY (p_outcomes))
      AND (coalesce(cardinality(p_devices), 0)   = 0 OR h.device   = ANY (p_devices))
      AND (coalesce(cardinality(p_countries), 0) = 0 OR h.country  = ANY (p_countries))
      AND (coalesce(cardinality(p_platforms), 0) = 0 OR h.platform = ANY (p_platforms))
      AND (NOT coalesce(p_hide_bots, false) OR NOT h.is_bot)
    GROUP BY 1
  )
  SELECT ok.edges[g.i], coalesce(a.bots, 0), coalesce(a.suspicious, 0), coalesce(a.passed, 0), coalesce(a.loaded, 0)
  FROM ok
  CROSS JOIN LATERAL generate_series(1, cardinality(ok.edges) - 1) AS g(i)
  LEFT JOIN agg a ON a.i = g.i
  ORDER BY g.i;
$function$;

REVOKE ALL ON FUNCTION pages.hit_series(timestamptz[], uuid, text[], text[], text[], boolean, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.hit_series(timestamptz[], uuid, text[], text[], text[], boolean, text[]) TO service_role;

-- ── recent_hits ─────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.recent_hits(integer, uuid, timestamptz, text[], text[], text[], boolean);

CREATE FUNCTION pages.recent_hits(p_limit integer DEFAULT 20, p_domain uuid DEFAULT NULL, p_since timestamptz DEFAULT NULL,
                                  p_outcomes text[] DEFAULT NULL, p_devices text[] DEFAULT NULL, p_countries text[] DEFAULT NULL,
                                  p_hide_bots boolean DEFAULT false, p_platforms text[] DEFAULT NULL)
RETURNS TABLE(created_at timestamptz, host text, path text, outcome text, status_code smallint, country text, device text,
              is_bot boolean, referrer_host text, ip text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT created_at, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip
  FROM pages.hits
  WHERE (p_since IS NULL OR created_at >= p_since)
    AND (p_domain IS NULL OR domain_id = p_domain)
    AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR outcome  = ANY (p_outcomes))
    AND (coalesce(cardinality(p_devices), 0)   = 0 OR device   = ANY (p_devices))
    AND (coalesce(cardinality(p_countries), 0) = 0 OR country  = ANY (p_countries))
    AND (coalesce(cardinality(p_platforms), 0) = 0 OR platform = ANY (p_platforms))
    AND (NOT coalesce(p_hide_bots, false) OR NOT is_bot)
  ORDER BY created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 200));
$function$;

REVOKE ALL ON FUNCTION pages.recent_hits(integer, uuid, timestamptz, text[], text[], text[], boolean, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.recent_hits(integer, uuid, timestamptz, text[], text[], text[], boolean, text[]) TO service_role;

-- ── hit_platforms: the filter's options ─────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.hit_platforms(p_since timestamptz, p_domain uuid DEFAULT NULL)
RETURNS TABLE(platform text, hits bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT platform, count(*) AS hits
  FROM pages.hits
  WHERE created_at >= p_since
    AND platform IS NOT NULL
    AND (p_domain IS NULL OR domain_id = p_domain)
  GROUP BY platform
  ORDER BY hits DESC, platform;
$function$;

REVOKE ALL ON FUNCTION pages.hit_platforms(timestamptz, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.hit_platforms(timestamptz, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
