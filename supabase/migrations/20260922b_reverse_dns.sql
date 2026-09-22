-- ============================================================================
-- DayOne Pages — reverse DNS para identificar servidores de bots
-- ============================================================================

-- Adiciona coluna de hostname resolvido via reverse DNS
ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS hostname text;

COMMENT ON COLUMN pages.hits.hostname IS 'Hostname resolvido via reverse DNS do IP (pode ajudar a identificar bots/data centers)';

-- Cria índice para buscar por hostname
CREATE INDEX IF NOT EXISTS idx_pages_hits_hostname ON pages.hits (hostname);
