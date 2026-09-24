-- ============================================================================
-- DayOne Pages — the pages of a funnel always add up to 100%
--
-- pages.traffic_weight is now the page's share (%) of its funnel's traffic,
-- and the dashboard keeps the shares of a funnel's non-archived pages adding
-- up to 100 (src/lib/pages/traffic.ts). Existing funnels whose shares don't
-- add up to 100 (every page started at the default 100) get an even split:
-- 50/50, 34/33/33… (the remainder goes to the oldest pages).
-- ============================================================================

WITH live AS (
  SELECT p.id, p.funnel_id,
         row_number() OVER (PARTITION BY p.funnel_id ORDER BY p.created_at, p.id) AS rn,
         count(*) OVER (PARTITION BY p.funnel_id) AS n,
         sum(p.traffic_weight) OVER (PARTITION BY p.funnel_id) AS total
  FROM pages.pages p
  WHERE p.funnel_id IS NOT NULL AND p.status <> 'ARCHIVED'
)
UPDATE pages.pages p
SET traffic_weight = (100 / live.n) + CASE WHEN live.rn <= 100 % live.n THEN 1 ELSE 0 END
FROM live
WHERE p.id = live.id AND live.total <> 100;
