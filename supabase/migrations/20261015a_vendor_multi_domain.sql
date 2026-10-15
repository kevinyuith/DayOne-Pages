-- ============================================================================
-- DayOne Pages — a vendor page on several domains (the owner, 15/10/2026: "cada produto pode
-- escolher os domínios que rodarão essas páginas"; "mesma página em N domínios").
--
-- Until now a page was listed by exactly one domain or funnel. A VENDOR site page (not an
-- upsell page) may now be listed by any number of VENDOR domains: every one serves the same page
-- and the same upsell funnel, and the funnel's numbers add the domains up (they already join the
-- hits of every domain that lists the page). Every other page keeps the old rule.
--
-- pages.vendor_page_domains_set(p_page, p_domains) sets the whole list at once: the page is added
-- to the given VENDOR domains and taken off the other VENDOR domains (its row stays — a vendor
-- page outlives its domains). It returns the hosts whose list changed, for the caller to purge.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.domains_page_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  pg record;
  v_scope text;
  v_kind text;
BEGIN
  IF coalesce(jsonb_typeof(NEW.page), '') <> 'object' THEN
    RAISE EXCEPTION 'domains.page must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR pg IN SELECT key, value FROM jsonb_each(NEW.page) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object' THEN
      RAISE EXCEPTION 'domains.page: invalid entry %', pg.key USING ERRCODE = 'check_violation';
    END IF;
    SELECT p.scope, p.kind INTO v_scope, v_kind FROM pages.page_content p WHERE p.id = pg.key::uuid;
    IF v_scope IS NULL OR v_scope NOT IN ('DOMAIN', 'VENDOR') THEN
      RAISE EXCEPTION 'domains.page: % is not a domain page', pg.key USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- An upsell page is served only through its vendor page's upsell funnel (20261014d).
    IF v_kind = 'UPSELL' THEN
      RAISE EXCEPTION 'domains.page: % is an upsell page; only an upsell funnel serves it', pg.key USING ERRCODE = 'check_violation';
    END IF;
    -- A vendor page is served only by a vendor domain (and a vendor domain keeps its type while it serves one).
    IF v_scope = 'VENDOR' AND NEW.type IS DISTINCT FROM 'VENDOR' THEN
      RAISE EXCEPTION 'domains.page: % is a vendor page; only a Vendor domain can serve it', pg.key USING ERRCODE = 'check_violation';
    END IF;
    -- One domain per page — except a vendor page, which any number of vendor domains may serve (20261015a).
    IF v_scope <> 'VENDOR' AND EXISTS (SELECT 1 FROM pages.domains o WHERE o.id <> NEW.id AND o.page ? pg.key) THEN
      RAISE EXCEPTION 'domains.page: page % belongs to another domain', pg.key USING ERRCODE = 'unique_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END $function$;

CREATE FUNCTION pages.vendor_page_domains_set(p_page uuid, p_domains uuid[])
RETURNS TABLE(domain text, listed boolean)
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_scope text;
  v_kind text;
  v_bad uuid;
  v_domains uuid[] := coalesce(p_domains, '{}');
BEGIN
  SELECT p.scope, p.kind INTO v_scope, v_kind FROM pages.page_content p WHERE p.id = p_page;
  IF v_scope IS DISTINCT FROM 'VENDOR' OR v_kind = 'UPSELL' THEN
    RAISE EXCEPTION 'vendor_page_domains_set: % is not a vendor site page', p_page USING ERRCODE = 'check_violation';
  END IF;
  SELECT d INTO v_bad FROM unnest(v_domains) d
  WHERE NOT EXISTS (SELECT 1 FROM pages.domains x WHERE x.id = d AND x.type = 'VENDOR')
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'vendor_page_domains_set: % is not a vendor domain', v_bad USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  WITH added AS (
    UPDATE pages.domains d SET page = d.page || jsonb_build_object(p_page::text, '{}'::jsonb)
    WHERE d.id = ANY (v_domains) AND NOT d.page ? p_page::text
    RETURNING d.domain, true
  ), removed AS (
    UPDATE pages.domains d SET page = d.page - p_page::text
    WHERE d.type = 'VENDOR' AND d.page ? p_page::text AND NOT d.id = ANY (v_domains)
    RETURNING d.domain, false
  )
  SELECT a.domain, a.bool FROM added a(domain, bool)
  UNION ALL
  SELECT r.domain, r.bool FROM removed r(domain, bool);
END $function$;
COMMENT ON FUNCTION pages.vendor_page_domains_set(uuid, uuid[]) IS
  'Sets the VENDOR domains that serve a vendor site page: added to the given ones, taken off the other VENDOR domains (the page row stays). Returns each host whose list changed (listed = true when added), for the caller to purge.';

REVOKE ALL ON FUNCTION pages.vendor_page_domains_set(uuid, uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.vendor_page_domains_set(uuid, uuid[]) TO service_role;
