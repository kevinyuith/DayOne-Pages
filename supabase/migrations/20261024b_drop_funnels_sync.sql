-- ============================================================================
-- DayOne Pages — pages.funnels_sync() is dropped (24/10/2026).
--
-- A no-op since 20261006b (`SELECT 0`): the funnel row is born with the funnel in pages.funnels. Its only
-- caller was the Funnel screen (getFunnelBoard in src/lib/pages/queries.ts), which no longer calls it.
-- APPLY ONLY AFTER that dashboard is live on Railway: the old screen throws when the call fails.
-- No cron job and no function body names it (checked 24/10).
-- ============================================================================

DROP FUNCTION pages.funnels_sync();
