-- ============================================================================
-- DayOne Pages — a domain's pages live in pages.domains.site
--
-- Follows 20260924_domain_pages. The domain copies no longer live in
-- pages.pages / pages.page_slugs: everything a domain serves is ONE jsonb
-- column on its own row, pages.domains.site:
--
--   {
--     "<page uuid>": {
--       "name": "...", "kind": "OTHER", "status": "PUBLISHED",
--       "template_id": "<uuid>" | null,
--       "created_at": "<timestamptz>", "updated_at": "<timestamptz>",
--       "slugs": {
--         "/":         { "title": null, "content": "<!doctype html>...", "content_type": "text/html; charset=utf-8",
--                        "is_active": true, "created_at": "...", "updated_at": "..." },
--         "/obrigado": { ... }
--       }
--     }
--   }
--
-- pages.pages / pages.page_slugs keep only the TEMPLATES. default_page_id,
-- filter_pass_page_id, filter_fail_page_id and domain_routes.page_id now point
-- at page keys inside the domain's site (checked by triggers, no FK).
--
-- Serving: match_routes reads the slug from site; slug_id is a stable uuid
-- made from (domain, page, slug) and content_hash is md5(content), the same
-- value page_slugs.content_hash had, so ETags do not change. resolve keeps
-- its result columns.
--
-- The editor writes through the domain_page_* / domain_slug_* functions,
-- which lock the domain row and change one page or slug at a time, with the
-- same optimistic concurrency the templates have (updated_at must match).
--
-- The copies made by 20260924_domain_pages keep their ids and content.
-- ============================================================================

-- ── Column ────────────────────────────────────────────────────────────────

ALTER TABLE pages.domains ADD COLUMN IF NOT EXISTS site jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN pages.domains.site IS 'Everything this domain serves: its pages (copies of templates) keyed by page uuid, each with its slugs and their HTML. See migration 20260924b_domain_site for the shape.';

-- ── Old links to pages.pages go away (they now point inside site) ─────────

DROP TRIGGER IF EXISTS trg_pages_domains_own_pages ON pages.domains;
DROP TRIGGER IF EXISTS trg_pages_domain_routes_own_page ON pages.domain_routes;
DROP TRIGGER IF EXISTS trg_pages_pages_owner_fixed ON pages.pages;
DROP FUNCTION IF EXISTS pages.domains_own_pages();
DROP FUNCTION IF EXISTS pages.pages_owner_fixed();
DROP FUNCTION IF EXISTS pages.copy_page_to_domain(uuid, uuid);
DROP FUNCTION IF EXISTS pages.replace_page_from_template(uuid, uuid);

ALTER TABLE pages.domains DROP CONSTRAINT IF EXISTS domains_default_page_id_fkey;
ALTER TABLE pages.domains DROP CONSTRAINT IF EXISTS domains_filter_pass_page_id_fkey;
ALTER TABLE pages.domains DROP CONSTRAINT IF EXISTS domains_filter_fail_page_id_fkey;
ALTER TABLE pages.domain_routes DROP CONSTRAINT IF EXISTS domain_routes_page_id_fkey;

COMMENT ON COLUMN pages.domains.default_page_id IS 'Fallback when no rule matches: serves the request path as a slug of this page. A page key in site.';
COMMENT ON COLUMN pages.domains.filter_pass_page_id IS 'Page served when the visitor passes the filter. A page key in site.';
COMMENT ON COLUMN pages.domains.filter_fail_page_id IS 'Page served when the visitor fails the filter. A page key in site.';
COMMENT ON COLUMN pages.domain_routes.page_id IS 'SERVE: the page to serve, a page key in the domain''s site.';

-- ── Move the copies from pages.pages into site ────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'pages' AND table_name = 'pages' AND column_name = 'domain_id') THEN
    EXECUTE $move$
      UPDATE pages.domains d
      SET site = d.site || (
        SELECT jsonb_object_agg(p.id::text, jsonb_build_object(
                 'name', p.name, 'kind', p.kind, 'status', p.status, 'template_id', p.template_id,
                 'created_at', p.created_at, 'updated_at', p.updated_at,
                 'slugs', coalesce((
                   SELECT jsonb_object_agg(s.slug, jsonb_build_object(
                            'title', s.title, 'content', s.content, 'content_type', s.content_type,
                            'is_active', s.is_active, 'created_at', s.created_at, 'updated_at', s.updated_at))
                   FROM pages.page_slugs s WHERE s.page_id = p.id), '{}'::jsonb)))
        FROM pages.pages p WHERE p.domain_id = d.id)
      WHERE EXISTS (SELECT 1 FROM pages.pages p WHERE p.domain_id = d.id)
    $move$;
    EXECUTE 'DELETE FROM pages.pages WHERE domain_id IS NOT NULL';
  END IF;
END $$;

ALTER TABLE pages.pages DROP COLUMN IF EXISTS domain_id;
ALTER TABLE pages.pages DROP COLUMN IF EXISTS template_id;
COMMENT ON TABLE pages.pages IS 'Templates: pages built in the dashboard and copied into domains (pages.domains.site). A template is never served directly. Content lives in page_slugs, one row per slug.';

-- ── Rules for site and the references into it ─────────────────────────────

CREATE OR REPLACE FUNCTION pages.domains_site_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  pg record;
  sl record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.site), '') <> 'object' THEN
    RAISE EXCEPTION 'domains.site must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR pg IN SELECT key, value FROM jsonb_each(NEW.site) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object'
       OR coalesce(jsonb_typeof(pg.value -> 'name'), '') <> 'string'
       OR length(btrim(pg.value ->> 'name')) NOT BETWEEN 1 AND 120
       OR coalesce(pg.value ->> 'kind', '') NOT IN ('PRESELL', 'ADVERTORIAL', 'VSL', 'CHECKOUT', 'SAFE', 'OTHER')
       OR coalesce(pg.value ->> 'status', '') NOT IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
       OR coalesce(jsonb_typeof(pg.value -> 'slugs'), '') <> 'object' THEN
      RAISE EXCEPTION 'domains.site: invalid page %', pg.key USING ERRCODE = 'check_violation';
    END IF;

    FOR sl IN SELECT key, value FROM jsonb_each(pg.value -> 'slugs') LOOP
      IF sl.key !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$'
         OR coalesce(jsonb_typeof(sl.value -> 'content'), '') <> 'string'
         OR coalesce(jsonb_typeof(sl.value -> 'is_active'), '') <> 'boolean' THEN
        RAISE EXCEPTION 'domains.site: invalid slug % in page %', sl.key, pg.key USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;

  IF (NEW.default_page_id IS NOT NULL AND NOT (NEW.site ? NEW.default_page_id::text))
     OR (NEW.filter_pass_page_id IS NOT NULL AND NOT (NEW.site ? NEW.filter_pass_page_id::text))
     OR (NEW.filter_fail_page_id IS NOT NULL AND NOT (NEW.site ? NEW.filter_fail_page_id::text)) THEN
    RAISE EXCEPTION 'domains: default and filter pages must be pages of this domain' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM pages.domain_routes r
    WHERE r.domain_id = NEW.id AND r.page_id IS NOT NULL AND NOT (NEW.site ? r.page_id::text)
  ) THEN
    RAISE EXCEPTION 'domains: a route still serves a page that is not in site' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_domains_site_check ON pages.domains;
CREATE TRIGGER trg_pages_domains_site_check
  BEFORE INSERT OR UPDATE OF site, default_page_id, filter_pass_page_id, filter_fail_page_id ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.domains_site_check();

CREATE OR REPLACE FUNCTION pages.domain_routes_own_page()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.page_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pages.domains d WHERE d.id = NEW.domain_id AND d.site ? NEW.page_id::text
  ) THEN
    RAISE EXCEPTION 'domain_routes: a route can only serve its domain''s own pages' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_pages_domain_routes_own_page
  BEFORE INSERT OR UPDATE OF page_id, domain_id ON pages.domain_routes
  FOR EACH ROW EXECUTE FUNCTION pages.domain_routes_own_page();

-- ── Pages of a domain: copy, replace, remove ──────────────────────────────

-- A template as a site page (without status or timestamps). NULL if the
-- template does not exist.
CREATE OR REPLACE FUNCTION pages.template_as_site_page(p_template uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
           'name', t.name, 'kind', t.kind, 'template_id', t.id,
           'slugs', coalesce((
             SELECT jsonb_object_agg(s.slug, jsonb_build_object(
                      'title', s.title, 'content', s.content, 'content_type', s.content_type,
                      'is_active', s.is_active, 'created_at', now(), 'updated_at', now()))
             FROM pages.page_slugs s WHERE s.page_id = t.id), '{}'::jsonb))
  FROM pages.pages t
  WHERE t.id = p_template
$$;

-- Copies a template into the domain as a new PUBLISHED page and returns its
-- id. A domain without a default page gets this one as default.
CREATE OR REPLACE FUNCTION pages.domain_page_copy(p_domain uuid, p_template uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_page jsonb := pages.template_as_site_page(p_template);
  v_id   uuid  := gen_random_uuid();
BEGIN
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'domain_page_copy: template not found' USING ERRCODE = 'no_data_found';
  END IF;
  v_page := v_page || jsonb_build_object('status', 'PUBLISHED', 'created_at', now(), 'updated_at', now());

  UPDATE pages.domains d
  SET site = d.site || jsonb_build_object(v_id::text, v_page),
      default_page_id = coalesce(d.default_page_id, v_id)
  WHERE d.id = p_domain;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_page_copy: domain not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_id;
END $$;

-- Replaces a domain page with a fresh copy of a template. Keeps the page id
-- (default page, filter and routes keep pointing at it), its status and
-- created_at. Edits made to the old content are lost.
CREATE OR REPLACE FUNCTION pages.domain_page_replace(p_domain uuid, p_page uuid, p_template uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_new jsonb := pages.template_as_site_page(p_template);
  v_old jsonb;
BEGIN
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'domain_page_replace: template not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT d.site -> p_page::text INTO v_old FROM pages.domains d WHERE d.id = p_domain FOR UPDATE;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'domain_page_replace: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
  v_new := v_new || jsonb_build_object('status', v_old -> 'status', 'created_at', v_old -> 'created_at', 'updated_at', now());
  UPDATE pages.domains SET site = jsonb_set(site, ARRAY[p_page::text], v_new) WHERE id = p_domain;
END $$;

-- Removes a page from the domain. Fails (check_violation) while the default
-- page, the filter or a route still uses it.
CREATE OR REPLACE FUNCTION pages.domain_page_remove(p_domain uuid, p_page uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.domains SET site = site - p_page::text WHERE id = p_domain AND site ? p_page::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_page_remove: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- ── Editor: save a page (and optionally one slug's HTML) ──────────────────

-- Zero rows back = conflict: the page or the slug changed since the editor
-- loaded it (updated_at differs), or it no longer exists.
CREATE OR REPLACE FUNCTION pages.domain_page_save(
  p_domain uuid, p_page uuid, p_name text, p_kind text, p_status text, p_expected_page_updated_at text,
  p_slug text DEFAULT NULL, p_content text DEFAULT NULL, p_expected_slug_updated_at text DEFAULT NULL
)
RETURNS TABLE (page_updated_at text, slug_updated_at text, content_hash text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_page jsonb;
  v_now  jsonb := to_jsonb(now());
BEGIN
  SELECT d.site -> p_page::text INTO v_page FROM pages.domains d WHERE d.id = p_domain FOR UPDATE;
  IF v_page IS NULL OR (v_page ->> 'updated_at') IS DISTINCT FROM p_expected_page_updated_at THEN
    RETURN;
  END IF;

  IF p_slug IS NOT NULL THEN
    IF v_page -> 'slugs' -> p_slug IS NULL
       OR (v_page -> 'slugs' -> p_slug ->> 'updated_at') IS DISTINCT FROM p_expected_slug_updated_at THEN
      RETURN;
    END IF;
    v_page := jsonb_set(v_page, ARRAY['slugs', p_slug, 'content'], to_jsonb(coalesce(p_content, '')));
    v_page := jsonb_set(v_page, ARRAY['slugs', p_slug, 'updated_at'], v_now);
  END IF;

  v_page := v_page || jsonb_build_object('name', p_name, 'kind', p_kind, 'status', p_status, 'updated_at', v_now);
  UPDATE pages.domains SET site = jsonb_set(site, ARRAY[p_page::text], v_page) WHERE id = p_domain;

  RETURN QUERY SELECT v_now #>> '{}',
                      CASE WHEN p_slug IS NOT NULL THEN v_now #>> '{}' END,
                      CASE WHEN p_slug IS NOT NULL THEN md5(coalesce(p_content, '')) END;
END $$;

-- ── Editor: slugs of a domain page ────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.domain_slug_create(p_domain uuid, p_page uuid, p_slug text, p_title text, p_content text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_slug text := pages.normalize_path(p_slug);
  v_page jsonb;
BEGIN
  IF v_slug !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' THEN
    RAISE EXCEPTION 'domain_slug_create: invalid slug %', v_slug USING ERRCODE = 'check_violation';
  END IF;
  SELECT d.site -> p_page::text INTO v_page FROM pages.domains d WHERE d.id = p_domain FOR UPDATE;
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'domain_slug_create: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF (v_page -> 'slugs') ? v_slug THEN
    RAISE EXCEPTION 'domain_slug_create: slug % already exists', v_slug USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE pages.domains
  SET site = jsonb_set(site, ARRAY[p_page::text, 'slugs', v_slug], jsonb_build_object(
               'title', nullif(btrim(coalesce(p_title, '')), ''), 'content', coalesce(p_content, ''),
               'content_type', 'text/html; charset=utf-8', 'is_active', true,
               'created_at', now(), 'updated_at', now()))
  WHERE id = p_domain;
  RETURN v_slug;
END $$;

CREATE OR REPLACE FUNCTION pages.domain_slug_rename(p_domain uuid, p_page uuid, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_new   text := pages.normalize_path(p_new);
  v_slugs jsonb;
BEGIN
  IF v_new !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' THEN
    RAISE EXCEPTION 'domain_slug_rename: invalid slug %', v_new USING ERRCODE = 'check_violation';
  END IF;
  SELECT d.site -> p_page::text -> 'slugs' INTO v_slugs FROM pages.domains d WHERE d.id = p_domain FOR UPDATE;
  IF v_slugs IS NULL OR NOT (v_slugs ? p_old) THEN
    RAISE EXCEPTION 'domain_slug_rename: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_new = p_old THEN
    RETURN v_new;
  END IF;
  IF v_slugs ? v_new THEN
    RAISE EXCEPTION 'domain_slug_rename: slug % already exists', v_new USING ERRCODE = 'unique_violation';
  END IF;
  v_slugs := (v_slugs - p_old) || jsonb_build_object(v_new, (v_slugs -> p_old) || jsonb_build_object('updated_at', now()));
  UPDATE pages.domains SET site = jsonb_set(site, ARRAY[p_page::text, 'slugs'], v_slugs) WHERE id = p_domain;
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION pages.domain_slug_set_active(p_domain uuid, p_page uuid, p_slug text, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.domains
  SET site = jsonb_set(site, ARRAY[p_page::text, 'slugs', p_slug, 'is_active'], to_jsonb(p_active))
  WHERE id = p_domain AND site -> p_page::text -> 'slugs' ? p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_slug_set_active: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pages.domain_slug_delete(p_domain uuid, p_page uuid, p_slug text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.domains
  SET site = site #- ARRAY[p_page::text, 'slugs', p_slug]
  WHERE id = p_domain AND site -> p_page::text -> 'slugs' ? p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_slug_delete: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- ── Reads without the HTML (lists, selects, logs) ─────────────────────────

CREATE OR REPLACE FUNCTION pages.domain_pages_summary(p_domain_ids uuid[] DEFAULT NULL)
RETURNS TABLE (domain_id uuid, page_id uuid, name text, kind text, status text, template_id uuid,
               created_at text, updated_at text, slugs jsonb)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT d.id, pg.key::uuid, pg.value ->> 'name', pg.value ->> 'kind', pg.value ->> 'status',
         nullif(pg.value ->> 'template_id', '')::uuid, pg.value ->> 'created_at', pg.value ->> 'updated_at',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'slug', sl.key, 'title', sl.value -> 'title', 'is_active', sl.value -> 'is_active',
                    'content_type', sl.value -> 'content_type', 'content_hash', md5(sl.value ->> 'content'),
                    'created_at', sl.value -> 'created_at', 'updated_at', sl.value -> 'updated_at')
                  ORDER BY sl.key)
           FROM jsonb_each(pg.value -> 'slugs') sl), '[]'::jsonb)
  FROM pages.domains d, jsonb_each(d.site) pg
  WHERE p_domain_ids IS NULL OR d.id = ANY (p_domain_ids)
  ORDER BY d.id, pg.value ->> 'created_at'
$$;

-- One slug with its HTML, for the editor.
CREATE OR REPLACE FUNCTION pages.domain_slug_get(p_domain uuid, p_page uuid, p_slug text)
RETURNS TABLE (content text, content_type text, title text, is_active boolean, created_at text, updated_at text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT x.s ->> 'content', x.s ->> 'content_type', x.s ->> 'title', (x.s ->> 'is_active')::boolean,
         x.s ->> 'created_at', x.s ->> 'updated_at'
  FROM (SELECT d.site -> p_page::text -> 'slugs' -> p_slug AS s FROM pages.domains d WHERE d.id = p_domain) x
  WHERE x.s IS NOT NULL
$$;

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.template_as_site_page(uuid)',
    'pages.domain_page_copy(uuid, uuid)',
    'pages.domain_page_replace(uuid, uuid, uuid)',
    'pages.domain_page_remove(uuid, uuid)',
    'pages.domain_page_save(uuid, uuid, text, text, text, text, text, text, text)',
    'pages.domain_slug_create(uuid, uuid, text, text, text)',
    'pages.domain_slug_rename(uuid, uuid, text, text)',
    'pages.domain_slug_set_active(uuid, uuid, text, boolean)',
    'pages.domain_slug_delete(uuid, uuid, text)',
    'pages.domain_pages_summary(uuid[])',
    'pages.domain_slug_get(uuid, uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- ── Serving from site ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.match_routes(p_host text, p_path text)
RETURNS TABLE (route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb,
               action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text,
               redirect_url text, status_code smallint, preserve_query boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH req AS (
    SELECT pages.normalize_host(p_host) AS host, pages.normalize_path(p_path) AS path
  ),
  dom AS (
    SELECT d.id, d.default_page_id, d.filter, d.filter_pass_page_id, d.filter_fail_page_id, d.block_bots, d.site
    FROM pages.domains d, req
    WHERE d.status = 'ACTIVE' AND d.domain = req.host
  ),
  candidates AS (
    SELECT NULL::uuid AS route_id, dom.id AS domain_id, -1 AS priority, 'BOTGATE' AS match_type,
           NULL::text AS path_pattern, '{"bot": true}'::jsonb AS conditions, 'BLOCK' AS action,
           NULL::uuid AS page_id, NULL::text AS slug, NULL::text AS redirect_url,
           403::smallint AS status_code, false AS preserve_query
    FROM dom
    WHERE dom.block_bots

    UNION ALL
    SELECT r.id AS route_id, r.domain_id, r.priority, r.match_type, r.path_pattern, r.conditions, r.action,
           r.page_id,
           CASE WHEN r.action = 'SERVE' THEN coalesce(r.slug, req.path) END AS slug,
           r.redirect_url, r.status_code, r.preserve_query
    FROM pages.domain_routes r
    JOIN dom ON dom.id = r.domain_id, req
    WHERE r.is_active
      AND CASE r.match_type
            WHEN 'ANY'    THEN true
            WHEN 'EXACT'  THEN req.path = r.path_pattern
            WHEN 'PREFIX' THEN r.path_pattern = '/' OR req.path = r.path_pattern
                               OR starts_with(req.path, r.path_pattern || '/')
            WHEN 'REGEX'  THEN req.path ~ r.path_pattern
          END

    UNION ALL
    SELECT NULL, dom.id, 2147483646, 'FILTER', NULL, dom.filter, 'SERVE',
           dom.filter_pass_page_id, req.path, NULL, NULL, true
    FROM dom, req
    WHERE dom.filter IS NOT NULL AND dom.filter_pass_page_id IS NOT NULL

    UNION ALL
    SELECT NULL, dom.id, 2147483647, 'FALLBACK', NULL, '{}'::jsonb, 'SERVE',
           coalesce(dom.filter_fail_page_id, dom.default_page_id), req.path, NULL, NULL, true
    FROM dom, req
    WHERE coalesce(dom.filter_fail_page_id, dom.default_page_id) IS NOT NULL
  )
  SELECT c.route_id, c.domain_id, c.priority, c.match_type, c.path_pattern, c.conditions, c.action,
         c.page_id, c.slug,
         CASE WHEN sl.content IS NOT NULL THEN md5(c.domain_id::text || ':' || c.page_id::text || ':' || c.slug)::uuid END AS slug_id,
         sl.content_type,
         md5(sl.content) AS content_hash,
         c.redirect_url, c.status_code, c.preserve_query
  FROM candidates c
  CROSS JOIN dom
  LEFT JOIN LATERAL (SELECT dom.site -> (c.page_id::text) AS pg) p ON true
  LEFT JOIN LATERAL (
    SELECT x.s ->> 'content' AS content,
           coalesce(x.s ->> 'content_type', 'text/html; charset=utf-8') AS content_type
    FROM (SELECT p.pg -> 'slugs' -> c.slug AS s) x
    WHERE coalesce((x.s ->> 'is_active')::boolean, false)
  ) sl ON true
  WHERE c.action <> 'SERVE' OR p.pg ->> 'status' = 'PUBLISHED'
  ORDER BY c.priority
$$;

COMMENT ON FUNCTION pages.match_routes(text, text) IS 'Bot gate (block_bots) + domain rules + filter + fallback, in priority order. Matches the PATH only; `conditions` (bot gate, rules and filter) are evaluated by the serving layer. Order: bot gate (BLOCK 403 for bots only) → manual rules → filter (passed → filter_pass_page) → fallback (filter_fail_page or default_page). Pages and slugs come from pages.domains.site; slug_id is md5(domain:page:slug) as a uuid and content_hash is md5(content). The first route whose conditions pass wins; SERVE with slug_id NULL → 404.';

CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text)
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
           CASE WHEN m.slug_id IS NOT NULL THEN d.site -> (m.page_id::text) -> 'slugs' -> (m.slug) ->> 'content' END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id;
END $$;

NOTIFY pgrst, 'reload schema';
