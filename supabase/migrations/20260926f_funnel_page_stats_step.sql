-- ============================================================================
-- DayOne Pages — a funnel step switch is not another view
--
-- A funnel is always served one step per response: going from the Pre Lander
-- to the Lander reloads the same URL, and that reload is its own hit, logged
-- with the decision 'SERVE · GATE · STEP' (the same visit, not a new one).
-- funnel_page_stats counts a page's views from the hits that opened the visit
-- only; its clicks (out of the page) from every hit, the Lander's included —
-- so views and clicks mean what they meant when every step came in one load.
-- Same signature: CREATE OR REPLACE keeps the grants.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.funnel_page_stats(p_since timestamptz)
RETURNS TABLE(funnel_page_id uuid, views bigint, clicks bigint)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT coalesce(p.funnel_page_id, p.id),
         count(*) FILTER (WHERE h.decision IS DISTINCT FROM 'SERVE · GATE · STEP'),
         count(h.clicked_at)
  FROM pages.hits h
  JOIN pages.pages p ON p.id = h.page_id
  WHERE h.created_at >= p_since
    AND h.loaded_at IS NOT NULL
    AND NOT h.is_bot
    AND (p.funnel_page_id IS NOT NULL OR p.scope = 'FUNNEL')
  GROUP BY 1
$function$;

NOTIFY pgrst, 'reload schema';
