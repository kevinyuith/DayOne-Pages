-- ============================================================================
-- DayOne Pages — reverse DNS to identify bot servers
-- ============================================================================

-- Adds a column for the hostname resolved via reverse DNS
ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS hostname text;

COMMENT ON COLUMN pages.hits.hostname IS 'Hostname resolved via reverse DNS of the IP (can help identify bots/data centers)';

-- Creates an index to search by hostname
CREATE INDEX IF NOT EXISTS idx_pages_hits_hostname ON pages.hits (hostname);
