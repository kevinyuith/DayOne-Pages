-- ============================================================================
-- DayOne Pages — Vendor pages: the product's own funnel, the vendor side (the owner, 13/10/2026:
-- a category for the product's funnel that comes from core; the screens are the owner's).
--
-- 1. pages.page_content.scope gains VENDOR. A vendor page is created like a template (a plain
--    insert with its slugs) and may exist before any domain; it is served by the one domain that
--    lists it, and only a domain whose type is VENDOR may list it (domains_page_check). Taking it
--    off the domain, or deleting the domain, keeps the row: it is the vendor's page, not the
--    domain's copy. match_routes doesn't look at the scope, so the delivery server serves it like
--    a domain page, at the requested path, and its HTML comes through content_get. The vendor's
--    traffic rules are still to be decided (the owner, 13/10): until then a vendor page goes
--    through the same gate as any domain page.
-- 2. pages.page_content.platform: the checkout platform a vendor page sells through —
--    PAGAMERICAN, CLICKBANK, BUYGOODS, CARTPANDA, DIGISTORE24 (the core's site packages pa, cb,
--    bg, cp, dg). NULL on every other scope; a vendor page with no checkout (the VIP area) may
--    leave it NULL.
-- 3. pages.products.checkout_links = { "<PLATFORM>": { "<key>": "<value>" } }. A vendor page's
--    {{checkout.<key>}} is the value of its product (product_id) on its platform: a checkout URL
--    with the offer and the affiliate (https://pay.pagamerican.app/<offer>?aff=<affiliate>), or the
--    bare offer code where the platform takes one (PagAmerican's one-click upsells,
--    data-pag-offer="{{checkout.up1}}"). pages.resolve merges them into the route's placeholders,
--    so the delivery server replaces them like {{company.*}} — no server change, and the ETag
--    follows the values (placeholders_etag). A key with no value stays as written (only known
--    keys are replaced). Written by pages.product_checkout_links_set (NULL back = the product
--    changed meanwhile).
--
-- pages.resolve is patched in place (like 20261012g): dayone-main's migration 20261006q added
-- `default_funnel` to it, so it is never rewritten from a file here.
-- ============================================================================

DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.page_content, pages.products IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock pages.page_content and pages.products in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

-- ── 1. The VENDOR scope ─────────────────────────────────────────────────────

ALTER TABLE pages.page_content DROP CONSTRAINT ck_pages_scope;
ALTER TABLE pages.page_content ADD CONSTRAINT ck_pages_scope
  CHECK (scope IN ('TEMPLATE', 'DOMAIN', 'FUNNEL', 'VENDOR'));

ALTER TABLE pages.page_content DROP CONSTRAINT ck_pages_kind_scope;
ALTER TABLE pages.page_content ADD CONSTRAINT ck_pages_kind_scope
  CHECK ((scope = 'TEMPLATE' AND kind <> 'FUNNEL')
      OR (scope = 'FUNNEL' AND kind = 'FUNNEL')
      OR scope = 'DOMAIN'
      OR (scope = 'VENDOR' AND kind <> 'FUNNEL'));

COMMENT ON COLUMN pages.page_content.scope IS
  'What the page is: TEMPLATE (the Page templates screen, never served), DOMAIN (a domain''s copy, served by it), FUNNEL (a page of a funnel) or VENDOR (the product''s own funnel, the vendor side: served by the one VENDOR domain that lists it, kept when the domain lets it go).';

-- ── 2. The vendor page's checkout platform ──────────────────────────────────

ALTER TABLE pages.page_content ADD COLUMN platform text;
ALTER TABLE pages.page_content ADD CONSTRAINT ck_pages_platform
  CHECK (platform IS NULL
      OR (scope = 'VENDOR' AND platform IN ('PAGAMERICAN', 'CLICKBANK', 'BUYGOODS', 'CARTPANDA', 'DIGISTORE24')));
COMMENT ON COLUMN pages.page_content.platform IS
  'A vendor page''s checkout platform (PAGAMERICAN, CLICKBANK, BUYGOODS, CARTPANDA, DIGISTORE24): its {{checkout.<key>}} are its product''s checkout_links on this platform. NULL on every other scope.';

-- ── 3. The product's checkout links, per platform ───────────────────────────

ALTER TABLE pages.products ADD COLUMN checkout_links jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN pages.products.checkout_links IS
  'The values of a vendor page''s {{checkout.<key>}}, per platform: { "<PLATFORM>": { "<key>": "<value>" } } — a checkout URL with offer and affiliate, or a bare offer code. Keys: lowercase letter, then letters, digits or _ (at most 40). Merged by pages.resolve into the placeholders of the vendor pages of this product. Written by pages.product_checkout_links_set.';

CREATE OR REPLACE FUNCTION pages.products_checkout_links_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  pl record;
  k  record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.checkout_links), '') <> 'object' THEN
    RAISE EXCEPTION 'products: checkout_links must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR pl IN SELECT key, value FROM jsonb_each(NEW.checkout_links) LOOP
    IF pl.key NOT IN ('PAGAMERICAN', 'CLICKBANK', 'BUYGOODS', 'CARTPANDA', 'DIGISTORE24') THEN
      RAISE EXCEPTION 'products: % is not a checkout platform', pl.key USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(jsonb_typeof(pl.value), '') <> 'object' THEN
      RAISE EXCEPTION 'products: the % checkout links must be an object', pl.key USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(pl.value)) > 100 THEN
      RAISE EXCEPTION 'products: at most 100 checkout links per platform' USING ERRCODE = 'check_violation';
    END IF;
    FOR k IN SELECT key, value FROM jsonb_each(pl.value) LOOP
      IF k.key !~ '^[a-z][a-z0-9_]{0,39}$' THEN
        RAISE EXCEPTION 'products: invalid checkout key "%" (lowercase letter, then letters, digits or _; at most 40)', k.key USING ERRCODE = 'check_violation';
      END IF;
      IF jsonb_typeof(k.value) <> 'string' OR length(k.value #>> '{}') > 2000 THEN
        RAISE EXCEPTION 'products: the checkout link % must be text of at most 2000 characters', k.key USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_pages_products_checkout_links_check
  BEFORE INSERT OR UPDATE OF checkout_links ON pages.products
  FOR EACH ROW EXECUTE FUNCTION pages.products_checkout_links_check();

-- The compatibility view takes the new column (CREATE OR REPLACE VIEW appends it, as in 20261012h).
CREATE OR REPLACE VIEW public.products WITH (security_invoker = true) AS SELECT * FROM pages.products;

CREATE OR REPLACE FUNCTION pages.product_checkout_links_set(p_product uuid, p_links jsonb, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  UPDATE pages.products
  SET checkout_links = coalesce(p_links, '{}'::jsonb), updated_at = clock_timestamp()
  WHERE id = p_product AND updated_at IS NOT DISTINCT FROM p_expected
  RETURNING updated_at INTO v_at;
  RETURN v_at;
END $$;
COMMENT ON FUNCTION pages.product_checkout_links_set(uuid, jsonb, timestamptz) IS
  'Replaces the product''s checkout_links, only over the version the caller read (p_expected = its updated_at). Returns the new updated_at, or NULL when the product changed meanwhile (or does not exist).';

-- ── Domains list vendor pages; a vendor page outlives its domain ────────────

CREATE OR REPLACE FUNCTION pages.domains_page_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  pg record;
  v_scope text;
BEGIN
  IF coalesce(jsonb_typeof(NEW.page), '') <> 'object' THEN
    RAISE EXCEPTION 'domains.page must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR pg IN SELECT key, value FROM jsonb_each(NEW.page) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object' THEN
      RAISE EXCEPTION 'domains.page: invalid entry %', pg.key USING ERRCODE = 'check_violation';
    END IF;
    SELECT p.scope INTO v_scope FROM pages.page_content p WHERE p.id = pg.key::uuid;
    IF v_scope IS NULL OR v_scope NOT IN ('DOMAIN', 'VENDOR') THEN
      RAISE EXCEPTION 'domains.page: % is not a domain page', pg.key USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- A vendor page is served only by a vendor domain (and a vendor domain keeps its type while it serves one).
    IF v_scope = 'VENDOR' AND NEW.type IS DISTINCT FROM 'VENDOR' THEN
      RAISE EXCEPTION 'domains.page: % is a vendor page; only a Vendor domain can serve it', pg.key USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM pages.domains o WHERE o.id <> NEW.id AND o.page ? pg.key) THEN
      RAISE EXCEPTION 'domains.page: page % belongs to another domain', pg.key USING ERRCODE = 'unique_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

DROP TRIGGER trg_pages_domains_page_check ON pages.domains;
CREATE TRIGGER trg_pages_domains_page_check
  BEFORE INSERT OR UPDATE OF page, type ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.domains_page_check();

-- Deleting a domain deletes its copies, not the vendor pages it served.
CREATE OR REPLACE FUNCTION pages.page_owner_deleted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  DELETE FROM pages.page_content p WHERE OLD.page ? p.id::text AND p.scope <> 'VENDOR';
  RETURN OLD;
END $$;

-- Taking a page off a domain deletes a copy; a vendor page just stops being served there.
CREATE OR REPLACE FUNCTION pages.domain_page_remove(p_domain uuid, p_page uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.domains SET page = page - p_page::text WHERE id = p_domain AND page ? p_page::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_page_remove: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
  DELETE FROM pages.page_content WHERE id = p_page AND scope <> 'VENDOR';
END $$;

-- ── Delivery: the HTML and the {{checkout.*}} values ────────────────────────

CREATE OR REPLACE FUNCTION pages.content_get(p_refs jsonb, p_key text)
RETURNS TABLE(page_id uuid, slug text, content_hash text, content text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.content_get: invalid key' USING ERRCODE = '28000';
  END IF;
  IF coalesce(jsonb_typeof(p_refs), '') <> 'array' OR jsonb_array_length(p_refs) > 50 THEN
    RAISE EXCEPTION 'pages.content_get: refs must be an array of at most 50 { page_id, slug }' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT p.id, r.slug, p.slugs -> r.slug ->> 'content_hash', p.slugs -> r.slug ->> 'content'
    FROM jsonb_to_recordset(p_refs) AS r(page_id uuid, slug text)
    JOIN pages.page_content p ON p.id = r.page_id AND p.scope IN ('DOMAIN', 'FUNNEL', 'VENDOR')
    WHERE p.slugs ? r.slug;
END $$;

DO $do$
DECLARE
  def  text := pg_get_functiondef('pages.resolve(text, text, text, boolean)'::regprocedure);
  next text;
BEGIN
  next := replace(def,
    $old$d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders,$old$,
    $new$d.placeholders || jsonb_build_object('domain', d.domain)
             -- A vendor page's {{checkout.<key>}}: its product's links on its platform (20261013a).
             || coalesce(ck.checkout, '{}'::jsonb) AS placeholders,$new$);
  IF next = def THEN
    RAISE EXCEPTION 'pages.resolve: the placeholders expression was not found';
  END IF;
  def := next;

  next := replace(def,
    $old$) vs ON true;$old$,
    $new$) vs ON true
    LEFT JOIN LATERAL (
      -- pages.products.checkout_links of the vendor page's product, on the page's platform, as checkout.<key>.
      SELECT jsonb_object_agg('checkout.' || l.key, l.value) AS checkout
      FROM pages.page_content vp
      JOIN pages.products pr ON pr.id = vp.product_id
      CROSS JOIN LATERAL jsonb_each(pr.checkout_links -> vp.platform) l
      WHERE vp.id = m.page_id AND vp.scope = 'VENDOR'
    ) ck ON true;$new$);
  IF next = def THEN
    RAISE EXCEPTION 'pages.resolve: the end of its query was not found';
  END IF;

  EXECUTE next;
END $do$;

REVOKE ALL ON FUNCTION pages.products_checkout_links_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.product_checkout_links_set(uuid, jsonb, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.product_checkout_links_set(uuid, jsonb, timestamptz) TO service_role;
