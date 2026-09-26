-- ============================================================================
-- DayOne Pages — the Dashboard's unique counts: bots, suspicious, loaded
--
-- hit_stats gains, next to `uniques` (distinct IPs), three per-category unique
-- visitor counts (distinct IP): bots_unique (is_bot), suspicious_unique (a rule
-- labeled it Suspicious) and loaded_unique (the page loaded — loaded_at). The
-- Dashboard shows Total requests, Unique visitors, Bots (Unique), Suspicious
-- (Unique) and Loaded (Unique). Return type changes, so DROP then CREATE.
-- ============================================================================

DROP FUNCTION IF EXISTS pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean);

CREATE FUNCTION pages.hit_stats(p_since timestamptz, p_domain uuid DEFAULT NULL, p_outcomes text[] DEFAULT NULL,
                                p_devices text[] DEFAULT NULL, p_countries text[] DEFAULT NULL, p_hide_bots boolean DEFAULT false)
RETURNS TABLE(total bigint, served bigint, blocked bigint, bots bigint, uniques bigint,
              bots_unique bigint, suspicious_unique bigint, loaded_unique bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT
    count(*)                                                        AS total,
    count(*) FILTER (WHERE outcome = 'served')                      AS served,
    count(*) FILTER (WHERE outcome IN ('blocked','bot'))            AS blocked,
    count(*) FILTER (WHERE is_bot)                                  AS bots,
    count(DISTINCT ip)                                              AS uniques,
    count(DISTINCT ip) FILTER (WHERE is_bot)                        AS bots_unique,
    count(DISTINCT ip) FILTER (WHERE rule_label = 'Suspicious')     AS suspicious_unique,
    count(DISTINCT ip) FILTER (WHERE loaded_at IS NOT NULL)         AS loaded_unique
  FROM pages.hits
  WHERE created_at >= p_since
    AND (p_domain IS NULL OR domain_id = p_domain)
    AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR outcome = ANY (p_outcomes))
    AND (coalesce(cardinality(p_devices), 0)   = 0 OR device  = ANY (p_devices))
    AND (coalesce(cardinality(p_countries), 0) = 0 OR country = ANY (p_countries))
    AND (NOT coalesce(p_hide_bots, false) OR NOT is_bot);
$function$;

NOTIFY pgrst, 'reload schema';
