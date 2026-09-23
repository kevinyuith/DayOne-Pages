-- ============================================================================
-- DayOne Pages — pages are templates; each domain serves its own copies
--
-- From now on a page either is a TEMPLATE (domain_id NULL, listed in the
-- dashboard's Pages screen) or belongs to exactly one domain (domain_id set).
-- A domain picks a template and gets a copy of it; editing the copy does not
-- touch the template and editing the template does not touch the copies.
-- A domain can only serve its own pages: default page, filter pass/fail pages
-- and SERVE routes are checked by triggers.
--
-- Also adds pages.domains.placeholders: the values for {{key}} placeholders in
-- the domain's pages (company name, phone, email, ...). The delivery server
-- replaces them when it serves a page; pages.resolve now returns them (plus
-- {{domain}}) in a new `placeholders` column. Old servers ignore the column.
--
-- Existing data: every page a domain uses today is copied into that domain
-- (same content, same status) and the domain is repointed to the copy, so
-- nothing changes for visitors. The originals stay as templates.
--
-- Idempotent: running it again finds no domain using a template and copies
-- nothing.
-- ============================================================================

-- ── Columns ────────────────────────────────────────────────────────────────

ALTER TABLE pages.pages
  ADD COLUMN IF NOT EXISTS domain_id   uuid REFERENCES pages.domains(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES pages.pages(id)   ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pages_pages_domain   ON pages.pages (domain_id);
CREATE INDEX IF NOT EXISTS idx_pages_pages_template ON pages.pages (template_id);

COMMENT ON COLUMN pages.pages.domain_id IS 'Owner domain. NULL = template (only copied, never served). Set = the domain''s own copy, served only by that domain. Fixed after insert.';
COMMENT ON COLUMN pages.pages.template_id IS 'Template this domain page was copied from. NULL for templates, or when the template was deleted.';

ALTER TABLE pages.domains
  ADD COLUMN IF NOT EXISTS placeholders jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pages.domains DROP CONSTRAINT IF EXISTS ck_domains_placeholders_object;
ALTER TABLE pages.domains ADD CONSTRAINT ck_domains_placeholders_object CHECK (jsonb_typeof(placeholders) = 'object');

COMMENT ON COLUMN pages.domains.placeholders IS 'Values for the {{key}} placeholders in this domain''s pages, e.g. {"company_name": "Acme LLC", "phone": "..."}. {{domain}} and {{year}} are automatic. The field list lives in src/lib/pages/placeholders.ts.';

-- Every field the dashboard offers, empty, so a page never shows a raw
-- {{key}} for a domain that has not filled its data yet. Existing values win.
UPDATE pages.domains
SET placeholders = jsonb_build_object(
      'company_name', '', 'phone', '', 'email', '', 'address', '',
      'city', '', 'state', '', 'zip_code', '', 'country', ''
    ) || placeholders;

-- Deleting a domain cascades to its routes AND its pages in one statement.
-- RESTRICT is checked immediately and could fire before the routes are gone;
-- NO ACTION is checked at the end of the statement. A page used by a route
-- still cannot be deleted on its own.
ALTER TABLE pages.domain_routes DROP CONSTRAINT IF EXISTS domain_routes_page_id_fkey;
ALTER TABLE pages.domain_routes
  ADD CONSTRAINT domain_routes_page_id_fkey FOREIGN KEY (page_id) REFERENCES pages.pages(id);

-- ── Copy and replace ───────────────────────────────────────────────────────

-- Copies a template (with all its slugs) into a domain. The copy starts
-- PUBLISHED: choosing a template for a domain is what puts it live.
CREATE OR REPLACE FUNCTION pages.copy_page_to_domain(p_template uuid, p_domain uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pages.domains d WHERE d.id = p_domain) THEN
    RAISE EXCEPTION 'copy_page_to_domain: domain not found' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO pages.pages (name, kind, status, notes, product_id, funnel_id, domain_id, template_id)
  SELECT t.name, t.kind, 'PUBLISHED', t.notes, t.product_id, t.funnel_id, p_domain, t.id
  FROM pages.pages t
  WHERE t.id = p_template AND t.domain_id IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'copy_page_to_domain: template not found' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO pages.page_slugs (page_id, slug, title, content, content_type, is_active, published_at)
  SELECT v_id, s.slug, s.title, s.content, s.content_type, s.is_active, s.published_at
  FROM pages.page_slugs s
  WHERE s.page_id = p_template;

  RETURN v_id;
END $$;

-- Replaces a domain page's content with a fresh copy of a template, keeping
-- the page id (so the default page, filter and routes keep pointing at it)
-- and its status. Edits made to the old content are lost.
CREATE OR REPLACE FUNCTION pages.replace_page_from_template(p_page uuid, p_template uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.pages p
  SET name = t.name, kind = t.kind, notes = t.notes, template_id = t.id
  FROM pages.pages t
  WHERE p.id = p_page AND p.domain_id IS NOT NULL
    AND t.id = p_template AND t.domain_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'replace_page_from_template: domain page or template not found' USING ERRCODE = 'no_data_found';
  END IF;

  DELETE FROM pages.page_slugs WHERE page_id = p_page;

  INSERT INTO pages.page_slugs (page_id, slug, title, content, content_type, is_active, published_at)
  SELECT p_page, s.slug, s.title, s.content, s.content_type, s.is_active, s.published_at
  FROM pages.page_slugs s
  WHERE s.page_id = p_template;
END $$;

REVOKE ALL ON FUNCTION pages.copy_page_to_domain(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.copy_page_to_domain(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION pages.replace_page_from_template(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.replace_page_from_template(uuid, uuid) TO service_role;

-- ── Existing data: give each domain its own copies ─────────────────────────

DO $$
DECLARE
  r      record;
  v_copy uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT u.domain_id, u.page_id
    FROM (
      SELECT d.id AS domain_id, d.default_page_id AS page_id FROM pages.domains d
      UNION SELECT d.id, d.filter_pass_page_id FROM pages.domains d
      UNION SELECT d.id, d.filter_fail_page_id FROM pages.domains d
      UNION SELECT rt.domain_id, rt.page_id FROM pages.domain_routes rt
    ) u
    JOIN pages.pages p ON p.id = u.page_id
    WHERE p.domain_id IS NULL
  LOOP
    v_copy := pages.copy_page_to_domain(r.page_id, r.domain_id);
    -- Same status as the original: a page that was not being served stays that way.
    UPDATE pages.pages c SET status = src.status FROM pages.pages src WHERE c.id = v_copy AND src.id = r.page_id;

    UPDATE pages.domains SET default_page_id = v_copy     WHERE id = r.domain_id AND default_page_id = r.page_id;
    UPDATE pages.domains SET filter_pass_page_id = v_copy WHERE id = r.domain_id AND filter_pass_page_id = r.page_id;
    UPDATE pages.domains SET filter_fail_page_id = v_copy WHERE id = r.domain_id AND filter_fail_page_id = r.page_id;
    UPDATE pages.domain_routes SET page_id = v_copy       WHERE domain_id = r.domain_id AND page_id = r.page_id;
  END LOOP;
END $$;

-- ── Rules: a domain only uses its own pages; ownership never changes ──────

CREATE OR REPLACE FUNCTION pages.domains_own_pages()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pages.pages p
    WHERE p.id IN (NEW.default_page_id, NEW.filter_pass_page_id, NEW.filter_fail_page_id)
      AND p.domain_id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'domains: a domain can only use its own pages' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_domains_own_pages ON pages.domains;
CREATE TRIGGER trg_pages_domains_own_pages
  BEFORE INSERT OR UPDATE OF default_page_id, filter_pass_page_id, filter_fail_page_id ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.domains_own_pages();

CREATE OR REPLACE FUNCTION pages.domain_routes_own_page()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.page_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pages.pages p WHERE p.id = NEW.page_id AND p.domain_id = NEW.domain_id
  ) THEN
    RAISE EXCEPTION 'domain_routes: a route can only serve its domain''s own pages' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_domain_routes_own_page ON pages.domain_routes;
CREATE TRIGGER trg_pages_domain_routes_own_page
  BEFORE INSERT OR UPDATE OF page_id, domain_id ON pages.domain_routes
  FOR EACH ROW EXECUTE FUNCTION pages.domain_routes_own_page();

CREATE OR REPLACE FUNCTION pages.pages_owner_fixed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.domain_id IS DISTINCT FROM OLD.domain_id THEN
    RAISE EXCEPTION 'pages: domain_id cannot change after the page is created' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_pages_owner_fixed ON pages.pages;
CREATE TRIGGER trg_pages_pages_owner_fixed
  BEFORE UPDATE OF domain_id ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION pages.pages_owner_fixed();

-- ── resolve: also return the domain's placeholder values ──────────────────

-- DROP + CREATE because the result columns change (CREATE OR REPLACE cannot).
DROP FUNCTION IF EXISTS pages.resolve(text, text, text);

CREATE FUNCTION pages.resolve(p_host text, p_path text, p_key text)
RETURNS TABLE (route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb,
               action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text,
               redirect_url text, status_code smallint, preserve_query boolean, content text, placeholders jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.resolve: invalid key' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
    SELECT m.route_id, m.domain_id, m.priority, m.match_type, m.path_pattern,
           m.conditions, m.action, m.page_id, m.slug, m.slug_id,
           m.content_type, m.content_hash, m.redirect_url, m.status_code,
           m.preserve_query,
           CASE WHEN m.slug_id IS NOT NULL THEN s.content END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.page_slugs AS s ON s.id = m.slug_id
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id;
END $$;

COMMENT ON FUNCTION pages.resolve(text, text, text) IS 'Routes from match_routes(host, path) + slug content + the domain''s placeholder values (with {{domain}}), in one call. Requires a key from pages.server_keys. Called by the delivery server via POST /rest/v1/rpc/resolve with Content-Profile: pages.';

REVOKE ALL ON FUNCTION pages.resolve(text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
