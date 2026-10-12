-- ============================================================================
-- New names (the owner, 12/10/2026): pages.pages → pages.page_content, pages.cta →
-- pages.cta_content, pages.domains.site → pages.domains.page, pages.funnels.site →
-- pages.funnels.page.
--
-- Renaming doesn't rewrite the functions' text, so every function that named the old ones is
-- rewritten here, in the same transaction (the pages schema's, and the four of dayone-main's
-- that read them: public.funnel_page_metrics, public.page_campaign_metrics, analytics.page_split,
-- management.page_asset_sweep_pending).
--
-- A BRIDGE keeps the old names working until both dashboards read the new ones (then a later
-- migration drops it):
--   * pages.pages and pages.cta are views over the renamed tables (simple views: they take
--     INSERT/UPDATE/DELETE, the tables' triggers still run, same grants);
--   * domains.site and funnels.site stay as columns kept equal to `page` by a trigger, both ways:
--     a write to the old name lands in `page` (dayone-main's White flow writes domains.site), and
--     the page checks run for a write to either name.
-- ============================================================================

-- The locks without queueing (see 20261006b): a pending ACCESS EXCLUSIVE request would stall every
-- reader of these tables (the gate's resolve) behind it.
DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.pages, pages.cta, pages.domains, pages.funnels IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock pages.pages, pages.cta, pages.domains and pages.funnels in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

ALTER TABLE pages.pages RENAME TO page_content;
ALTER TABLE pages.cta RENAME TO cta_content;
ALTER TABLE pages.domains RENAME COLUMN site TO page;
ALTER TABLE pages.funnels RENAME COLUMN site TO page;

COMMENT ON TABLE pages.page_content IS
  'Every page — template, domain page or funnel page — with its slugs and HTML (slugs). Carries the HTML: never select *, read through pages.pages_summary / domain_pages_summary / funnel_pages_summary.';
COMMENT ON TABLE pages.cta_content IS
  'A CTA: the bundles block shown under the VSL at the pitch — a funnel''s (funnel_id) or a library design (funnel_id NULL). Carries its HTML: never select *, read through pages.cta_summary / pages.cta_get.';
COMMENT ON COLUMN pages.domains.page IS 'The domain''s pages: { "<page id>": {} }.';
COMMENT ON COLUMN pages.funnels.page IS 'The funnel''s pages and their A/B share: { "<page id>": { "weight": 0-100 } }.';

-- ── Rewrite every function that named the old ones ──────────────────────────

DO $rw$
DECLARE
  r     record;
  def   text;
  total int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind = 'f'
      AND n.nspname IN ('pages', 'public', 'analytics', 'management')
      AND (p.prosrc ~ 'pages\.pages\M' OR p.prosrc ~ 'pages\.cta\M'
           OR (n.nspname = 'pages' AND p.prosrc ~ '\msite\M')
           OR (n.nspname = 'public' AND p.proname = 'funnel_page_metrics'))
  LOOP
    def := regexp_replace(r.def, 'pages\.pages\M', 'pages.page_content', 'g');
    def := regexp_replace(def, 'pages\.cta\M', 'pages.cta_content', 'g');
    -- In these functions every `site` is the domains/funnels column (and its error messages).
    IF r.nspname = 'pages' OR (r.nspname = 'public' AND r.proname = 'funnel_page_metrics') THEN
      def := regexp_replace(def, '\msite\M', 'page', 'g');
    END IF;
    IF def <> r.def THEN
      EXECUTE def;
      total := total + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'rewrote % functions', total;
END $rw$;

-- ── The bridge: the old names ───────────────────────────────────────────────

CREATE VIEW pages.pages WITH (security_invoker = true) AS SELECT * FROM pages.page_content;
CREATE VIEW pages.cta WITH (security_invoker = true) AS SELECT * FROM pages.cta_content;
COMMENT ON VIEW pages.pages IS 'Bridge (12/10/2026): the old name of pages.page_content, until both dashboards read the new one.';
COMMENT ON VIEW pages.cta IS 'Bridge (12/10/2026): the old name of pages.cta_content, until both dashboards read the new one.';
REVOKE ALL ON pages.pages, pages.cta FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pages.pages, pages.cta TO service_role;

ALTER TABLE pages.domains ADD COLUMN site jsonb;
ALTER TABLE pages.funnels ADD COLUMN site jsonb;
COMMENT ON COLUMN pages.domains.site IS 'Bridge (12/10/2026): the old name of domains.page, kept equal to it by trg_pages_domains_0_site_bridge.';
COMMENT ON COLUMN pages.funnels.site IS 'Bridge (12/10/2026): the old name of funnels.page, kept equal to it by trg_pages_funnels_0_site_bridge.';

-- Filled without the tables' triggers: nothing else changes (updated_at stays).
ALTER TABLE pages.domains DISABLE TRIGGER USER;
UPDATE pages.domains SET site = page;
ALTER TABLE pages.domains ENABLE TRIGGER USER;
ALTER TABLE pages.funnels DISABLE TRIGGER USER;
UPDATE pages.funnels SET site = page;
ALTER TABLE pages.funnels ENABLE TRIGGER USER;

-- A write to the old name lands in `page`; `site` always ends equal to `page`.
CREATE OR REPLACE FUNCTION pages.page_site_bridge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site IS DISTINCT FROM OLD.site AND NEW.page IS NOT DISTINCT FROM OLD.page THEN
    NEW.page := NEW.site;
  ELSIF TG_OP = 'INSERT' AND NEW.site IS NOT NULL AND NEW.page = '{}'::jsonb THEN
    NEW.page := NEW.site;
  END IF;
  NEW.site := NEW.page;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pages.page_site_bridge() FROM public, anon, authenticated;

-- First of the BEFORE triggers (they run by name), so the page checks see the bridged value.
CREATE TRIGGER trg_pages_domains_0_site_bridge BEFORE INSERT OR UPDATE ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.page_site_bridge();
CREATE TRIGGER trg_pages_funnels_0_site_bridge BEFORE INSERT OR UPDATE ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.page_site_bridge();

-- The page checks run for a write to either name.
DROP TRIGGER IF EXISTS trg_pages_domains_site_check ON pages.domains;
CREATE TRIGGER trg_pages_domains_site_check BEFORE INSERT OR UPDATE OF page, site ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.domains_site_check();
DROP TRIGGER IF EXISTS trg_pages_funnels_site_check ON pages.funnels;
CREATE TRIGGER trg_pages_funnels_site_check BEFORE INSERT OR UPDATE OF page, site ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.funnels_site_check();

-- ── Nothing left on the old names ───────────────────────────────────────────

DO $chk$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND (p.prosrc ~ 'pages\.pages\M' OR p.prosrc ~ 'pages\.cta\M'
         OR (n.nspname = 'pages' AND p.proname <> 'page_site_bridge' AND p.prosrc ~ '\msite\M'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'still on the old names: %', bad;
  END IF;
END $chk$;

NOTIFY pgrst, 'reload schema';
