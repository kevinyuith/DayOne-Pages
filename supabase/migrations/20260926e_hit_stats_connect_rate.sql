-- ============================================================================
-- DayOne Pages — the Dashboard's Unique visitors and connect rate
--
-- `uniques` counts only the visitors (distinct IP) that got a 200: the www
-- redirects, the 404s and the errors no longer make a visitor. `gate_unique`
-- (new) is the visitors that passed the gate — a funnel page served by the
-- gate (decision SERVE · GATE) with a 200; a funnel redirect (302) passed it
-- too, but has no page to load, so it stays out. `loaded_unique` is now the
-- ones among them whose page loaded (only a funnel page served by the gate
-- carries the load beacon), so loaded_unique / gate_unique is the connect
-- rate the Loaded (Unique) card shows. Return type changes, so DROP then CREATE.
-- ============================================================================

DROP FUNCTION IF EXISTS pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean);

CREATE FUNCTION pages.hit_stats(p_since timestamptz, p_domain uuid DEFAULT NULL, p_outcomes text[] DEFAULT NULL,
                                p_devices text[] DEFAULT NULL, p_countries text[] DEFAULT NULL, p_hide_bots boolean DEFAULT false)
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
    AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR outcome = ANY (p_outcomes))
    AND (coalesce(cardinality(p_devices), 0)   = 0 OR device  = ANY (p_devices))
    AND (coalesce(cardinality(p_countries), 0) = 0 OR country = ANY (p_countries))
    AND (NOT coalesce(p_hide_bots, false) OR NOT is_bot);
$function$;

-- Like the other Dashboard functions: the service role only (20260926c recreated it without these).
REVOKE ALL ON FUNCTION pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
