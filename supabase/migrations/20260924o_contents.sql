-- ============================================================================
-- DayOne Pages — pages.contents: the HTML lives apart, addressed by its hash
--
-- Until now the HTML of every slug sat inside pages.domains.site and
-- pages.funnels.site ("content": "<!doctype html>..."). Now:
--
--   pages.contents   id = sha256 of the HTML (hex), content = the HTML.
--                    An id never changes its content: editing a slug stores
--                    the new HTML under a new id. The same HTML is stored
--                    once, so a copy (template -> domain, funnel -> domain)
--                    shares the row until someone edits it.
--   site slugs       { title, content_id, content_type, is_active,
--                      created_at, updated_at } — no HTML in site any more.
--
-- Serving: match_routes returns content_hash = content_id (the ETag changes
-- once). resolve gains p_with_content (default true, so the servers already
-- deployed keep getting the HTML); the new delivery server asks with false,
-- keeps the HTML on disk by id and fetches only the ids it does not have yet
-- through pages.content_get.
--
-- Clean-up: pages.contents_gc() deletes contents no domain or funnel uses and
-- nobody stored for 7 days (used_at); a daily pg_cron job runs it.
--
-- Templates (pages.page_slugs) keep their HTML: they are never served.
-- ============================================================================

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.content_id(p_content text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT encode(sha256(convert_to(coalesce(p_content, ''), 'UTF8')), 'hex')
$$;

CREATE TABLE IF NOT EXISTS pages.contents (
  id         text        PRIMARY KEY,
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_contents_id CHECK (id = pages.content_id(content))
);
COMMENT ON TABLE pages.contents IS 'The HTML of every domain and funnel slug, addressed by its sha256 (id). Rows never change content; site jsonb points at them by content_id.';
COMMENT ON COLUMN pages.contents.used_at IS 'Last time a write stored this content. pages.contents_gc() deletes rows unused by any site and not stored for a while.';

ALTER TABLE pages.contents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.contents FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pages.contents TO service_role;

-- Stores the HTML (or touches the row that already has it) and returns its id.
-- Touching used_at also makes a concurrent contents_gc() skip the row.
CREATE OR REPLACE FUNCTION pages.content_put(p_content text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id text := pages.content_id(p_content);
BEGIN
  INSERT INTO pages.contents AS c (id, content) VALUES (v_id, coalesce(p_content, ''))
  ON CONFLICT (id) DO UPDATE SET used_at = now();
  RETURN v_id;
END $$;

-- ── Move the HTML out of site ───────────────────────────────────────────────

INSERT INTO pages.contents (id, content)
SELECT DISTINCT pages.content_id(sl.value ->> 'content'), coalesce(sl.value ->> 'content', '')
FROM (
  SELECT d.site AS site FROM pages.domains d
  UNION ALL
  SELECT f.site FROM pages.funnels f
) s, jsonb_each(s.site) pg, jsonb_each(pg.value -> 'slugs') sl
WHERE sl.value ? 'content'
ON CONFLICT (id) DO NOTHING;

-- The checks now want content_id (and the row it points at).
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
       OR coalesce(pg.value ->> 'kind', '') NOT IN ('PRESELL', 'ADVERTORIAL', 'VSL', 'CHECKOUT', 'SAFE', 'OTHER', 'FUNNEL')
       OR coalesce(pg.value ->> 'status', '') NOT IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
       OR coalesce(jsonb_typeof(pg.value -> 'slugs'), '') <> 'object' THEN
      RAISE EXCEPTION 'domains.site: invalid page %', pg.key USING ERRCODE = 'check_violation';
    END IF;

    FOR sl IN SELECT key, value FROM jsonb_each(pg.value -> 'slugs') LOOP
      IF sl.key !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$'
         OR coalesce(sl.value ->> 'content_id', '') !~ '^[0-9a-f]{64}$'
         OR sl.value ? 'content'
         OR coalesce(jsonb_typeof(sl.value -> 'is_active'), '') <> 'boolean' THEN
        RAISE EXCEPTION 'domains.site: invalid slug % in page %', sl.key, pg.key USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pages.contents c WHERE c.id = sl.value ->> 'content_id') THEN
        RAISE EXCEPTION 'domains.site: slug % in page % points at a missing content', sl.key, pg.key USING ERRCODE = 'foreign_key_violation';
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

CREATE OR REPLACE FUNCTION pages.funnels_site_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  pg record;
  sl record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.site), '') <> 'object' THEN
    RAISE EXCEPTION 'funnels.site must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR pg IN SELECT key, value FROM jsonb_each(NEW.site) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object'
       OR coalesce(jsonb_typeof(pg.value -> 'name'), '') <> 'string'
       OR length(btrim(pg.value ->> 'name')) NOT BETWEEN 1 AND 120
       OR coalesce(pg.value ->> 'status', '') NOT IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
       OR coalesce(pg.value ->> 'weight', '') !~ '^\d{1,3}$'
       OR (pg.value ->> 'weight')::int > 100
       OR coalesce(jsonb_typeof(pg.value -> 'slugs'), '') <> 'object' THEN
      RAISE EXCEPTION 'funnels.site: invalid page %', pg.key USING ERRCODE = 'check_violation';
    END IF;
    FOR sl IN SELECT key, value FROM jsonb_each(pg.value -> 'slugs') LOOP
      IF sl.key !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$'
         OR coalesce(sl.value ->> 'content_id', '') !~ '^[0-9a-f]{64}$'
         OR sl.value ? 'content'
         OR coalesce(jsonb_typeof(sl.value -> 'is_active'), '') <> 'boolean' THEN
        RAISE EXCEPTION 'funnels.site: invalid slug % in page %', sl.key, pg.key USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pages.contents c WHERE c.id = sl.value ->> 'content_id') THEN
        RAISE EXCEPTION 'funnels.site: slug % in page % points at a missing content', sl.key, pg.key USING ERRCODE = 'foreign_key_violation';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;

-- site with every slug's "content" swapped for its "content_id" (the rows were inserted above).
CREATE OR REPLACE FUNCTION pages.site_without_html(p_site jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_object_agg(pg.key, pg.value || jsonb_build_object('slugs', coalesce((
           SELECT jsonb_object_agg(sl.key, CASE WHEN sl.value ? 'content'
                    THEN (sl.value - 'content') || jsonb_build_object('content_id', pages.content_id(sl.value ->> 'content'))
                    ELSE sl.value END)
           FROM jsonb_each(pg.value -> 'slugs') sl), '{}'::jsonb))), '{}'::jsonb)
  FROM jsonb_each(p_site) pg
$$;

UPDATE pages.domains SET site = pages.site_without_html(site) WHERE site::text LIKE '%"content"%';
UPDATE pages.funnels SET site = pages.site_without_html(site) WHERE site::text LIKE '%"content"%';
DROP FUNCTION pages.site_without_html(jsonb);

COMMENT ON COLUMN pages.domains.site IS 'Everything this domain serves: its pages keyed by page uuid, each with its slugs ({ title, content_id, content_type, is_active, created_at, updated_at }). The HTML lives in pages.contents.';
COMMENT ON COLUMN pages.funnels.site IS '{ "<page uuid>": { name, status, weight (0-100, the pages add up to 100), notes, created_at, updated_at, slugs: { "/path": { title, content_id, content_type, is_active, created_at, updated_at } } } }. The HTML lives in pages.contents.';

-- ── Writers ─────────────────────────────────────────────────────────────────

-- A template as a site page (its HTML stored in pages.contents).
CREATE OR REPLACE FUNCTION pages.template_as_site_page(p_template uuid)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
           'name', t.name, 'kind', t.kind, 'template_id', t.id,
           'slugs', coalesce((
             SELECT jsonb_object_agg(s.slug, jsonb_build_object(
                      'title', s.title, 'content_id', pages.content_put(s.content), 'content_type', s.content_type,
                      'is_active', s.is_active, 'created_at', now(), 'updated_at', now()))
             FROM pages.page_slugs s WHERE s.page_id = t.id), '{}'::jsonb))
  FROM pages.pages t
  WHERE t.id = p_template
$$;

CREATE OR REPLACE FUNCTION pages.domain_page_add(p_domain uuid, p_template uuid, p_name text, p_contents jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_page jsonb := pages.template_as_site_page(p_template);
  v_id   uuid  := gen_random_uuid();
  r      record;
BEGIN
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'domain_page_add: template not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF coalesce(jsonb_typeof(p_contents), '') <> 'object' THEN
    RAISE EXCEPTION 'domain_page_add: contents must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN SELECT key, value FROM jsonb_each_text(p_contents) LOOP
    IF (v_page -> 'slugs') ? r.key THEN
      v_page := jsonb_set(v_page, ARRAY['slugs', r.key, 'content_id'], to_jsonb(pages.content_put(r.value)));
    END IF;
  END LOOP;

  v_page := v_page || jsonb_build_object(
    'name', coalesce(nullif(btrim(p_name), ''), v_page ->> 'name'),
    'status', 'PUBLISHED', 'created_at', now(), 'updated_at', now());

  UPDATE pages.domains d
  SET site = d.site || jsonb_build_object(v_id::text, v_page),
      default_page_id = coalesce(d.default_page_id, v_id)
  WHERE d.id = p_domain;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_page_add: domain not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_id;
END $$;

-- Zero rows back = conflict (updated_at differs) or the page is gone.
-- content_hash = the new content_id.
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
  v_cid  text;
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
    v_cid := pages.content_put(p_content);
    v_page := jsonb_set(v_page, ARRAY['slugs', p_slug, 'content_id'], to_jsonb(v_cid));
    v_page := jsonb_set(v_page, ARRAY['slugs', p_slug, 'updated_at'], v_now);
  END IF;

  v_page := v_page || jsonb_build_object('name', p_name, 'kind', p_kind, 'status', p_status, 'updated_at', v_now);
  UPDATE pages.domains SET site = jsonb_set(site, ARRAY[p_page::text], v_page) WHERE id = p_domain;

  RETURN QUERY SELECT v_now #>> '{}', CASE WHEN p_slug IS NOT NULL THEN v_now #>> '{}' END, v_cid;
END $$;

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
               'title', nullif(btrim(coalesce(p_title, '')), ''), 'content_id', pages.content_put(p_content),
               'content_type', 'text/html; charset=utf-8', 'is_active', true,
               'created_at', now(), 'updated_at', now()))
  WHERE id = p_domain;
  RETURN v_slug;
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_page_add(p_funnel uuid, p_name text, p_slugs jsonb, p_notes text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id    uuid := gen_random_uuid();
  v_slugs jsonb;
BEGIN
  IF coalesce(jsonb_typeof(p_slugs), '') <> 'object' OR p_slugs = '{}'::jsonb THEN
    RAISE EXCEPTION 'funnel_page_add: slugs must be a non-empty object' USING ERRCODE = 'check_violation';
  END IF;
  SELECT jsonb_object_agg(pages.normalize_path(s.key), jsonb_build_object(
           'title', nullif(btrim(coalesce(s.value ->> 'title', '')), ''),
           'content_id', pages.content_put(s.value ->> 'content'),
           'content_type', coalesce(s.value ->> 'content_type', 'text/html; charset=utf-8'),
           'is_active', coalesce((s.value ->> 'is_active')::boolean, true),
           'created_at', now(), 'updated_at', now()))
  INTO v_slugs
  FROM jsonb_each(p_slugs) s;

  UPDATE pages.funnels f
  SET site = f.site || jsonb_build_object(v_id::text, jsonb_build_object(
               'name', btrim(p_name), 'status', 'DRAFT', 'weight', 100, 'notes', p_notes,
               'created_at', now(), 'updated_at', now(), 'slugs', v_slugs))
  WHERE f.id = p_funnel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_page_add: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_page_save(
  p_funnel uuid, p_page uuid, p_name text, p_status text, p_expected_page_updated_at text,
  p_slug text DEFAULT NULL, p_content text DEFAULT NULL, p_expected_slug_updated_at text DEFAULT NULL
)
RETURNS TABLE (page_updated_at text, slug_updated_at text, content_hash text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_page jsonb;
  v_now  jsonb := to_jsonb(now());
  v_cid  text;
BEGIN
  SELECT f.site -> p_page::text INTO v_page FROM pages.funnels f WHERE f.id = p_funnel FOR UPDATE;
  IF v_page IS NULL OR (v_page ->> 'updated_at') IS DISTINCT FROM p_expected_page_updated_at THEN
    RETURN;
  END IF;
  IF p_slug IS NOT NULL THEN
    IF v_page -> 'slugs' -> p_slug IS NULL
       OR (v_page -> 'slugs' -> p_slug ->> 'updated_at') IS DISTINCT FROM p_expected_slug_updated_at THEN
      RETURN;
    END IF;
    v_cid := pages.content_put(p_content);
    v_page := jsonb_set(v_page, ARRAY['slugs', p_slug, 'content_id'], to_jsonb(v_cid));
    v_page := jsonb_set(v_page, ARRAY['slugs', p_slug, 'updated_at'], v_now);
  END IF;
  v_page := v_page || jsonb_build_object('name', p_name, 'status', p_status, 'updated_at', v_now);
  UPDATE pages.funnels SET site = jsonb_set(site, ARRAY[p_page::text], v_page) WHERE id = p_funnel;
  RETURN QUERY SELECT v_now #>> '{}', CASE WHEN p_slug IS NOT NULL THEN v_now #>> '{}' END, v_cid;
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_create(p_funnel uuid, p_page uuid, p_slug text, p_title text, p_content text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_slug text := pages.normalize_path(p_slug);
  v_page jsonb;
BEGIN
  IF v_slug !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' THEN
    RAISE EXCEPTION 'funnel_slug_create: invalid slug %', v_slug USING ERRCODE = 'check_violation';
  END IF;
  SELECT f.site -> p_page::text INTO v_page FROM pages.funnels f WHERE f.id = p_funnel FOR UPDATE;
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'funnel_slug_create: funnel page not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF (v_page -> 'slugs') ? v_slug THEN
    RAISE EXCEPTION 'funnel_slug_create: slug % already exists', v_slug USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE pages.funnels
  SET site = jsonb_set(site, ARRAY[p_page::text, 'slugs', v_slug], jsonb_build_object(
               'title', nullif(btrim(coalesce(p_title, '')), ''), 'content_id', pages.content_put(p_content),
               'content_type', 'text/html; charset=utf-8', 'is_active', true,
               'created_at', now(), 'updated_at', now()))
  WHERE id = p_funnel;
  RETURN v_slug;
END $$;

-- ── Readers (dashboard) ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.domain_slug_get(p_domain uuid, p_page uuid, p_slug text)
RETURNS TABLE (content text, content_type text, title text, is_active boolean, created_at text, updated_at text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.content, x.s ->> 'content_type', x.s ->> 'title', (x.s ->> 'is_active')::boolean,
         x.s ->> 'created_at', x.s ->> 'updated_at'
  FROM (SELECT d.site -> p_page::text -> 'slugs' -> p_slug AS s FROM pages.domains d WHERE d.id = p_domain) x
  JOIN pages.contents c ON c.id = x.s ->> 'content_id'
$$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_get(p_funnel uuid, p_page uuid, p_slug text)
RETURNS TABLE (content text, content_type text, title text, is_active boolean, created_at text, updated_at text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.content, x.s ->> 'content_type', x.s ->> 'title', (x.s ->> 'is_active')::boolean,
         x.s ->> 'created_at', x.s ->> 'updated_at'
  FROM (SELECT f.site -> p_page::text -> 'slugs' -> p_slug AS s FROM pages.funnels f WHERE f.id = p_funnel) x
  JOIN pages.contents c ON c.id = x.s ->> 'content_id'
$$;

-- content_hash = content_id: no HTML is read.
CREATE OR REPLACE FUNCTION pages.domain_pages_summary(p_domain_ids uuid[] DEFAULT NULL)
RETURNS TABLE (domain_id uuid, page_id uuid, name text, kind text, status text, template_id uuid, funnel_page_id uuid,
               created_at text, updated_at text, slugs jsonb)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT d.id, pg.key::uuid, pg.value ->> 'name', pg.value ->> 'kind', pg.value ->> 'status',
         nullif(pg.value ->> 'template_id', '')::uuid, nullif(pg.value ->> 'funnel_page_id', '')::uuid,
         pg.value ->> 'created_at', pg.value ->> 'updated_at',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'slug', sl.key, 'title', sl.value -> 'title', 'is_active', sl.value -> 'is_active',
                    'content_type', sl.value -> 'content_type', 'content_hash', sl.value -> 'content_id',
                    'created_at', sl.value -> 'created_at', 'updated_at', sl.value -> 'updated_at')
                  ORDER BY sl.key)
           FROM jsonb_each(pg.value -> 'slugs') sl), '[]'::jsonb)
  FROM pages.domains d, jsonb_each(d.site) pg
  WHERE p_domain_ids IS NULL OR d.id = ANY (p_domain_ids)
  ORDER BY d.id, pg.value ->> 'created_at'
$$;

CREATE OR REPLACE FUNCTION pages.funnel_pages_summary(p_funnel_ids uuid[] DEFAULT NULL)
RETURNS TABLE (funnel_id uuid, main_funnel_id uuid, page_id uuid, name text, status text, weight int, notes text,
               created_at text, updated_at text, slugs jsonb)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.id, f.main_funnel_id, pg.key::uuid, pg.value ->> 'name', pg.value ->> 'status',
         (pg.value ->> 'weight')::int, pg.value ->> 'notes', pg.value ->> 'created_at', pg.value ->> 'updated_at',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'slug', sl.key, 'title', sl.value -> 'title', 'is_active', sl.value -> 'is_active',
                    'content_type', sl.value -> 'content_type', 'content_hash', sl.value -> 'content_id',
                    'created_at', sl.value -> 'created_at', 'updated_at', sl.value -> 'updated_at')
                  ORDER BY sl.key)
           FROM jsonb_each(pg.value -> 'slugs') sl), '[]'::jsonb)
  FROM pages.funnels f, jsonb_each(f.site) pg
  WHERE p_funnel_ids IS NULL OR f.id = ANY (p_funnel_ids)
  ORDER BY f.id, pg.value ->> 'created_at', pg.key
$$;

-- ── Serving ─────────────────────────────────────────────────────────────────

-- content_hash = the slug's content_id (no HTML read here).
CREATE OR REPLACE FUNCTION pages.match_routes(p_host text, p_path text)
RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb, action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text, status_code smallint, preserve_query boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
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
         CASE WHEN sl.content_id IS NOT NULL THEN md5(c.domain_id::text || ':' || c.page_id::text || ':' || c.slug)::uuid END AS slug_id,
         sl.content_type,
         sl.content_id AS content_hash,
         c.redirect_url, c.status_code, c.preserve_query
  FROM candidates c
  CROSS JOIN dom
  LEFT JOIN LATERAL (SELECT dom.site -> (c.page_id::text) AS pg) p ON true
  LEFT JOIN LATERAL (
    SELECT x.s ->> 'content_id' AS content_id,
           coalesce(x.s ->> 'content_type', 'text/html; charset=utf-8') AS content_type
    FROM (SELECT p.pg -> 'slugs' -> c.slug AS s) x
    WHERE coalesce((x.s ->> 'is_active')::boolean, false)
  ) sl ON true
  WHERE c.action <> 'SERVE' OR p.pg ->> 'status' = 'PUBLISHED'
  ORDER BY c.priority
$function$;

-- p_with_content = false: ids only (content_hash is the content id); the
-- server fetches what it lacks with pages.content_get. Default true keeps the
-- servers already deployed working.
DROP FUNCTION IF EXISTS pages.resolve(text, text, text);
CREATE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb, action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text, status_code smallint, preserve_query boolean, content text, placeholders jsonb, split jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
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
           CASE WHEN p_with_content AND m.slug_id IS NOT NULL
                THEN (SELECT c.content FROM pages.contents c WHERE c.id = m.content_hash) END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders,
           sp.split
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id
    -- The funnel of the resolved page (a copy of a funnel page), if any.
    LEFT JOIN LATERAL (
      SELECT d.site -> (m.page_id::text) ->> 'funnel_id' AS funnel_id
      WHERE m.slug_id IS NOT NULL
    ) f ON true
    -- Every published copy of a page of that funnel with an active slug at this
    -- path; the weight comes live from pages.funnels (a removed page = 0).
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'page_id', pg.key,
               'slug_id', md5(d.id::text || ':' || pg.key || ':' || m.slug)::uuid,
               'content_type', coalesce(sl.s ->> 'content_type', 'text/html; charset=utf-8'),
               'content_hash', sl.s ->> 'content_id',
               'content', CASE WHEN p_with_content THEN (SELECT c.content FROM pages.contents c WHERE c.id = sl.s ->> 'content_id') END,
               'weight', coalesce((fu.site -> (pg.value ->> 'funnel_page_id') ->> 'weight')::int, 0))
             ORDER BY pg.value ->> 'created_at', pg.key) AS split
      FROM jsonb_each(d.site) pg
      LEFT JOIN pages.funnels fu ON fu.id::text = pg.value ->> 'funnel_id'
      CROSS JOIN LATERAL (SELECT pg.value -> 'slugs' -> (m.slug) AS s) sl
      WHERE f.funnel_id IS NOT NULL
        AND pg.value ->> 'funnel_id' = f.funnel_id
        AND pg.value ->> 'status' = 'PUBLISHED'
        AND coalesce((sl.s ->> 'is_active')::boolean, false)
      HAVING count(*) > 1
    ) sp ON true;
END $function$;

-- The HTML of the given content ids, for the delivery server (same key as resolve).
CREATE OR REPLACE FUNCTION pages.content_get(p_ids text[], p_key text)
RETURNS TABLE (id text, content text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.content_get: invalid key' USING ERRCODE = '28000';
  END IF;
  IF coalesce(array_length(p_ids, 1), 0) > 50 THEN
    RAISE EXCEPTION 'pages.content_get: at most 50 ids per call' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT c.id, c.content FROM pages.contents c WHERE c.id = ANY (p_ids);
END $function$;

-- ── Clean-up ────────────────────────────────────────────────────────────────

-- Deletes contents no domain or funnel points at and nobody stored for
-- p_unused_for. Returns how many went.
CREATE OR REPLACE FUNCTION pages.contents_gc(p_unused_for interval DEFAULT '7 days')
RETURNS int
LANGUAGE sql
SET search_path = ''
AS $$
  WITH used AS (
    SELECT sl.value ->> 'content_id' AS id
    FROM pages.domains d, jsonb_each(d.site) pg, jsonb_each(pg.value -> 'slugs') sl
    UNION
    SELECT sl.value ->> 'content_id'
    FROM pages.funnels f, jsonb_each(f.site) pg, jsonb_each(pg.value -> 'slugs') sl
  ), gone AS (
    DELETE FROM pages.contents c
    WHERE c.used_at < now() - p_unused_for
      AND NOT EXISTS (SELECT 1 FROM used u WHERE u.id = c.id)
    RETURNING 1
  )
  SELECT count(*)::int FROM gone
$$;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'dayone-pages-contents-gc';
SELECT cron.schedule('dayone-pages-contents-gc', '41 5 * * *', 'SELECT pages.contents_gc()');

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.content_id(text)',
    'pages.content_put(text)',
    'pages.contents_gc(interval)',
    'pages.template_as_site_page(uuid)',
    'pages.domain_page_add(uuid, uuid, text, jsonb)',
    'pages.domain_page_save(uuid, uuid, text, text, text, text, text, text, text)',
    'pages.domain_slug_create(uuid, uuid, text, text, text)',
    'pages.funnel_page_add(uuid, text, jsonb, text)',
    'pages.funnel_page_save(uuid, uuid, text, text, text, text, text, text)',
    'pages.funnel_slug_create(uuid, uuid, text, text, text)',
    'pages.domain_slug_get(uuid, uuid, text)',
    'pages.funnel_slug_get(uuid, uuid, text)',
    'pages.domain_pages_summary(uuid[])',
    'pages.funnel_pages_summary(uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION pages.domains_site_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.funnels_site_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.resolve(text, text, text, boolean) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text, boolean) TO anon, service_role;
REVOKE ALL ON FUNCTION pages.content_get(text[], text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.content_get(text[], text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
