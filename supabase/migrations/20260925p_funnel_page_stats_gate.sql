-- ============================================================================
-- DayOne Pages — funnel page numbers count the gate's funnel pages
--
-- The load notice (beacon.php) is now only on a funnel's page served by the
-- gate (match_type GATE): the hit's page_id is the funnel page itself
-- (scope FUNNEL). funnel_page_stats counted only domain copies of funnel pages
-- (pages.funnel_page_id), which the gate serves as the safe page — without the
-- notice from now on. It now counts both: the funnel page served by the gate
-- (its own id) and, for the hits already logged, the copies.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.funnel_page_stats(p_since timestamptz)
RETURNS TABLE(funnel_page_id uuid, views bigint, clicks bigint)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT coalesce(p.funnel_page_id, p.id), count(*), count(h.clicked_at)
  FROM pages.hits h
  JOIN pages.pages p ON p.id = h.page_id
  WHERE h.created_at >= p_since
    AND h.loaded_at IS NOT NULL
    AND NOT h.is_bot
    AND (p.funnel_page_id IS NOT NULL OR p.scope = 'FUNNEL')
  GROUP BY 1
$function$;
