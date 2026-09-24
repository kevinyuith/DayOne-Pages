-- ============================================================================
-- DayOne Pages — domain type: Media Buyer or Vendor
--
-- Chosen when the domain is added and editable on the domain's page. NULL =
-- not chosen yet (domains added before this, or registered from the Logs).
-- It is a label for now: serving does not depend on it.
-- ============================================================================

ALTER TABLE pages.domains ADD COLUMN IF NOT EXISTS type text;
ALTER TABLE pages.domains DROP CONSTRAINT IF EXISTS ck_domains_type;
ALTER TABLE pages.domains ADD CONSTRAINT ck_domains_type CHECK (type IS NULL OR type IN ('MEDIA_BUYER', 'VENDOR'));
COMMENT ON COLUMN pages.domains.type IS 'Who the domain is for: MEDIA_BUYER or VENDOR. NULL = not chosen yet.';

NOTIFY pgrst, 'reload schema';
