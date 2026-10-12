-- ============================================================================
-- The end of the bridge of 20261012d (pages.pages → page_content, pages.cta → cta_content,
-- domains/funnels.site → page): both dashboards read and write the new names (dayone-pages 575b261,
-- dayone-main 4ce4054ab), so the old names go — the views pages.pages and pages.cta, the bridge
-- columns domains.site / funnels.site and their trigger. The page checks run on `page` alone again,
-- and the functions and triggers that still said "site" are renamed to "page".
-- ============================================================================

DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.domains, pages.funnels, pages.page_content, pages.cta_content IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock pages.domains, pages.funnels, pages.page_content and pages.cta_content in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

DROP VIEW IF EXISTS pages.pages;
DROP VIEW IF EXISTS pages.cta;

DROP TRIGGER IF EXISTS trg_pages_domains_0_site_bridge ON pages.domains;
DROP TRIGGER IF EXISTS trg_pages_funnels_0_site_bridge ON pages.funnels;
DROP FUNCTION IF EXISTS pages.page_site_bridge();

DROP TRIGGER IF EXISTS trg_pages_domains_site_check ON pages.domains;
DROP TRIGGER IF EXISTS trg_pages_funnels_site_check ON pages.funnels;
ALTER TABLE pages.domains DROP COLUMN site;
ALTER TABLE pages.funnels DROP COLUMN site;

ALTER FUNCTION pages.domains_site_check() RENAME TO domains_page_check;
ALTER FUNCTION pages.funnels_site_check() RENAME TO funnels_page_check;
ALTER FUNCTION pages.site_owner_deleted() RENAME TO page_owner_deleted;
CREATE TRIGGER trg_pages_domains_page_check BEFORE INSERT OR UPDATE OF page ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.domains_page_check();
CREATE TRIGGER trg_pages_funnels_page_check BEFORE INSERT OR UPDATE OF page ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.funnels_page_check();

DROP TABLE IF EXISTS pages.tmp_bridge_usage;

-- Nothing left on the old names.
DO $chk$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND (p.prosrc ~ 'pages\.pages\M' OR p.prosrc ~ 'pages\.cta\M' OR (n.nspname = 'pages' AND p.prosrc ~ '\msite\M'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'still on the old names: %', bad;
  END IF;
END $chk$;

NOTIFY pgrst, 'reload schema';
