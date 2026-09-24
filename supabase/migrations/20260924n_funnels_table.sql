-- ============================================================================
-- DayOne Pages — pages.funnels: the funnel pages live apart from the templates
--
-- Until now a funnel page was a template (pages.pages kind FUNNEL +
-- pages.page_slugs). Now:
--
--   pages.pages / pages.page_slugs  templates only (the Templates screen)
--   pages.funnels                   one row per dayone-main funnel
--                                   (main_funnel_id -> public.funnels), and in
--                                   `site` (jsonb) everything of its pages:
--                                   { "<page uuid>": { name, status, weight,
--                                     notes, created_at, updated_at,
--                                     slugs: { "/path": { title, content,
--                                     content_type, is_active, created_at,
--                                     updated_at } } } }
--                                   (same shape as pages.domains.site; weight =
--                                   the page's share of the funnel's A/B test,
--                                   0-100, the pages add up to 100)
--   pages.domains.site              a copy of a funnel page carries funnel_id
--                                   (pages.funnels.id) and funnel_page_id; the
--                                   delivery server's split groups the copies
--                                   by funnel_id and reads the weight live.
--
-- Writes to funnels.site only through the pages.funnel_* functions (they lock
-- the row and change one page or slug at a time; save uses optimistic
-- concurrency on updated_at), like domain_page_* / domain_slug_*.
--
-- The 3 existing funnel pages move over with their ids; no domain had a copy
-- of them yet. pages.pages loses traffic_weight, funnel_id and the FUNNEL
-- kind: a template never belongs to a funnel.
-- ============================================================================

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pages.funnels (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  main_funnel_id uuid        UNIQUE REFERENCES public.funnels(id) ON DELETE SET NULL,
  site           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pages.funnels IS 'The pages of each dayone-main funnel (A/B test between them), HTML included, in `site` (same shape as domains.site plus weight). Written only through pages.funnel_* functions.';
COMMENT ON COLUMN pages.funnels.main_funnel_id IS 'The dayone-main funnel (public.funnels, F1, F2...). NULL = that funnel was deleted in dayone-main; the pages stay.';
COMMENT ON COLUMN pages.funnels.site IS '{ "<page uuid>": { name, status, weight (0-100, the pages add up to 100), notes, created_at, updated_at, slugs: { "/path": { title, content, content_type, is_active, created_at, updated_at } } } }';

ALTER TABLE pages.funnels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.funnels FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pages.funnels TO service_role;

DROP TRIGGER IF EXISTS trg_pages_funnels_updated_at ON pages.funnels;
CREATE TRIGGER trg_pages_funnels_updated_at BEFORE UPDATE ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.set_updated_at();

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
         OR coalesce(jsonb_typeof(sl.value -> 'content'), '') <> 'string'
         OR coalesce(jsonb_typeof(sl.value -> 'is_active'), '') <> 'boolean' THEN
        RAISE EXCEPTION 'funnels.site: invalid slug % in page %', sl.key, pg.key USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_funnels_site_check ON pages.funnels;
CREATE TRIGGER trg_pages_funnels_site_check BEFORE INSERT OR UPDATE OF site ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.funnels_site_check();

-- ── Move the existing funnel pages ──────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pages.pages WHERE kind = 'FUNNEL' AND funnel_id IS NULL) THEN
    RAISE EXCEPTION 'a FUNNEL page without a funnel; move it by hand first' USING ERRCODE = 'check_violation';
  END IF;
END $$;

INSERT INTO pages.funnels (main_funnel_id)
SELECT DISTINCT p.funnel_id FROM pages.pages p WHERE p.kind = 'FUNNEL'
ON CONFLICT (main_funnel_id) DO NOTHING;

UPDATE pages.funnels f
SET site = f.site || moved.pages
FROM (
  SELECT p.funnel_id,
         jsonb_object_agg(p.id::text, jsonb_build_object(
           'name', p.name, 'status', p.status, 'weight', p.traffic_weight, 'notes', p.notes,
           'created_at', p.created_at, 'updated_at', p.updated_at,
           'slugs', coalesce((
             SELECT jsonb_object_agg(s.slug, jsonb_build_object(
                      'title', s.title, 'content', s.content, 'content_type', s.content_type,
                      'is_active', s.is_active, 'created_at', s.created_at, 'updated_at', s.updated_at))
             FROM pages.page_slugs s WHERE s.page_id = p.id), '{}'::jsonb))) AS pages
  FROM pages.pages p
  WHERE p.kind = 'FUNNEL'
  GROUP BY p.funnel_id
) moved
WHERE f.main_funnel_id = moved.funnel_id;

DELETE FROM pages.page_slugs WHERE page_id IN (SELECT id FROM pages.pages WHERE kind = 'FUNNEL');
DELETE FROM pages.pages WHERE kind = 'FUNNEL';

-- pages.pages is templates only again.
ALTER TABLE pages.pages DROP CONSTRAINT IF EXISTS ck_pages_traffic_weight;
ALTER TABLE pages.pages DROP COLUMN IF EXISTS traffic_weight;
ALTER TABLE pages.pages DROP COLUMN IF EXISTS funnel_id;
ALTER TABLE pages.pages DROP CONSTRAINT IF EXISTS pages_kind_check;
ALTER TABLE pages.pages ADD CONSTRAINT pages_kind_check
  CHECK (kind = ANY (ARRAY['PRESELL', 'ADVERTORIAL', 'VSL', 'CHECKOUT', 'SAFE', 'OTHER']));
COMMENT ON COLUMN pages.pages.kind IS 'Template kind. Funnel pages live in pages.funnels.';

-- ── Funnel pages: create, save, remove, weights ─────────────────────────────

-- The pages.funnels row of a dayone-main funnel, created on first use.
CREATE OR REPLACE FUNCTION pages.funnel_for(p_main_funnel uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO pages.funnels (main_funnel_id) VALUES (p_main_funnel) ON CONFLICT (main_funnel_id) DO NOTHING;
  SELECT f.id INTO v_id FROM pages.funnels f WHERE f.main_funnel_id = p_main_funnel;
  RETURN v_id;
END $$;

-- Adds a page (DRAFT, weight 100 — the dashboard rebalances right after).
-- p_slugs: { "/path": { "title": ..., "content": ..., "content_type": ..., "is_active": ... } }.
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
           'content', coalesce(s.value ->> 'content', ''),
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

-- Zero rows back = conflict (updated_at differs) or the page is gone.
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
    v_page := jsonb_set(v_page, ARRAY['slugs', p_slug, 'content'], to_jsonb(coalesce(p_content, '')));
    v_page := jsonb_set(v_page, ARRAY['slugs', p_slug, 'updated_at'], v_now);
  END IF;
  v_page := v_page || jsonb_build_object('name', p_name, 'status', p_status, 'updated_at', v_now);
  UPDATE pages.funnels SET site = jsonb_set(site, ARRAY[p_page::text], v_page) WHERE id = p_funnel;
  RETURN QUERY SELECT v_now #>> '{}',
                      CASE WHEN p_slug IS NOT NULL THEN v_now #>> '{}' END,
                      CASE WHEN p_slug IS NOT NULL THEN md5(coalesce(p_content, '')) END;
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_page_remove(p_funnel uuid, p_page uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.funnels SET site = site - p_page::text WHERE id = p_funnel AND site ? p_page::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_page_remove: funnel page not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- Sets the weight of the pages listed in p_weights ({ "<page uuid>": 0-100 }).
CREATE OR REPLACE FUNCTION pages.funnel_set_weights(p_funnel uuid, p_weights jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_site jsonb;
  w      record;
BEGIN
  SELECT f.site INTO v_site FROM pages.funnels f WHERE f.id = p_funnel FOR UPDATE;
  IF v_site IS NULL THEN
    RAISE EXCEPTION 'funnel_set_weights: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  FOR w IN SELECT key, value FROM jsonb_each(p_weights) LOOP
    IF v_site ? w.key THEN
      v_site := jsonb_set(v_site, ARRAY[w.key, 'weight'], w.value);
    END IF;
  END LOOP;
  UPDATE pages.funnels SET site = v_site WHERE id = p_funnel;
END $$;

-- The funnel (pages.funnels.id) that holds a page, or NULL.
CREATE OR REPLACE FUNCTION pages.funnel_page_find(p_page uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.id FROM pages.funnels f WHERE f.site ? p_page::text
$$;

-- ── Funnel pages: slugs ─────────────────────────────────────────────────────

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
               'title', nullif(btrim(coalesce(p_title, '')), ''), 'content', coalesce(p_content, ''),
               'content_type', 'text/html; charset=utf-8', 'is_active', true,
               'created_at', now(), 'updated_at', now()))
  WHERE id = p_funnel;
  RETURN v_slug;
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_rename(p_funnel uuid, p_page uuid, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_new   text := pages.normalize_path(p_new);
  v_slugs jsonb;
BEGIN
  IF v_new !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' THEN
    RAISE EXCEPTION 'funnel_slug_rename: invalid slug %', v_new USING ERRCODE = 'check_violation';
  END IF;
  SELECT f.site -> p_page::text -> 'slugs' INTO v_slugs FROM pages.funnels f WHERE f.id = p_funnel FOR UPDATE;
  IF v_slugs IS NULL OR NOT (v_slugs ? p_old) THEN
    RAISE EXCEPTION 'funnel_slug_rename: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_new = p_old THEN
    RETURN v_new;
  END IF;
  IF v_slugs ? v_new THEN
    RAISE EXCEPTION 'funnel_slug_rename: slug % already exists', v_new USING ERRCODE = 'unique_violation';
  END IF;
  v_slugs := (v_slugs - p_old) || jsonb_build_object(v_new, (v_slugs -> p_old) || jsonb_build_object('updated_at', now()));
  UPDATE pages.funnels SET site = jsonb_set(site, ARRAY[p_page::text, 'slugs'], v_slugs) WHERE id = p_funnel;
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_set_active(p_funnel uuid, p_page uuid, p_slug text, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.funnels
  SET site = jsonb_set(site, ARRAY[p_page::text, 'slugs', p_slug, 'is_active'], to_jsonb(p_active))
  WHERE id = p_funnel AND site -> p_page::text -> 'slugs' ? p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_slug_set_active: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_delete(p_funnel uuid, p_page uuid, p_slug text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.funnels
  SET site = site #- ARRAY[p_page::text, 'slugs', p_slug]
  WHERE id = p_funnel AND site -> p_page::text -> 'slugs' ? p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_slug_delete: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- ── Funnel pages: reads ─────────────────────────────────────────────────────

-- Every funnel page without the HTML. p_funnel_ids NULL = all funnels.
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
                    'content_type', sl.value -> 'content_type', 'content_hash', md5(sl.value ->> 'content'),
                    'created_at', sl.value -> 'created_at', 'updated_at', sl.value -> 'updated_at')
                  ORDER BY sl.key)
           FROM jsonb_each(pg.value -> 'slugs') sl), '[]'::jsonb)
  FROM pages.funnels f, jsonb_each(f.site) pg
  WHERE p_funnel_ids IS NULL OR f.id = ANY (p_funnel_ids)
  ORDER BY f.id, pg.value ->> 'created_at', pg.key
$$;

-- One slug with its HTML, for the editor.
CREATE OR REPLACE FUNCTION pages.funnel_slug_get(p_funnel uuid, p_page uuid, p_slug text)
RETURNS TABLE (content text, content_type text, title text, is_active boolean, created_at text, updated_at text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT x.s ->> 'content', x.s ->> 'content_type', x.s ->> 'title', (x.s ->> 'is_active')::boolean,
         x.s ->> 'created_at', x.s ->> 'updated_at'
  FROM (SELECT f.site -> p_page::text -> 'slugs' -> p_slug AS s FROM pages.funnels f WHERE f.id = p_funnel) x
  WHERE x.s IS NOT NULL
$$;

-- The domains that have a copy of a page of the funnel (to purge their cache).
CREATE OR REPLACE FUNCTION pages.funnel_domains(p_funnel uuid)
RETURNS TABLE (domain_id uuid, domain text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT d.id, d.domain
  FROM pages.domains d
  WHERE EXISTS (SELECT 1 FROM jsonb_each(d.site) pg WHERE pg.value ->> 'funnel_id' = p_funnel::text)
$$;

-- ── Copying a funnel to a domain ────────────────────────────────────────────

-- Copies every non-archived page of the funnel into the domain as PUBLISHED
-- pages carrying funnel_id and funnel_page_id; returns how many. A domain
-- without a default page gets the first one.
CREATE OR REPLACE FUNCTION pages.domain_funnel_copy(p_domain uuid, p_funnel uuid)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_add   jsonb := '{}'::jsonb;
  v_first uuid;
  v_id    uuid;
  pg      record;
BEGIN
  FOR pg IN
    SELECT p.key, p.value FROM pages.funnels f, jsonb_each(f.site) p
    WHERE f.id = p_funnel AND p.value ->> 'status' <> 'ARCHIVED'
    ORDER BY p.value ->> 'created_at', p.key
  LOOP
    v_id := gen_random_uuid();
    v_first := coalesce(v_first, v_id);
    v_add := v_add || jsonb_build_object(v_id::text, jsonb_build_object(
      'name', pg.value ->> 'name', 'kind', 'FUNNEL', 'status', 'PUBLISHED', 'template_id', NULL,
      'funnel_id', p_funnel, 'funnel_page_id', pg.key,
      'created_at', now(), 'updated_at', now(),
      'slugs', coalesce((
        SELECT jsonb_object_agg(s.key, s.value || jsonb_build_object('created_at', now(), 'updated_at', now()))
        FROM jsonb_each(pg.value -> 'slugs') s), '{}'::jsonb)));
  END LOOP;
  IF v_first IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE pages.domains d
  SET site = d.site || v_add, default_page_id = coalesce(d.default_page_id, v_first)
  WHERE d.id = p_domain;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_funnel_copy: domain not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN (SELECT count(*) FROM jsonb_object_keys(v_add));
END $$;

-- ── Domain page summary with the funnel page it copies ──────────────────────

DROP FUNCTION IF EXISTS pages.domain_pages_summary(uuid[]);
CREATE FUNCTION pages.domain_pages_summary(p_domain_ids uuid[] DEFAULT NULL)
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
                    'content_type', sl.value -> 'content_type', 'content_hash', md5(sl.value ->> 'content'),
                    'created_at', sl.value -> 'created_at', 'updated_at', sl.value -> 'updated_at')
                  ORDER BY sl.key)
           FROM jsonb_each(pg.value -> 'slugs') sl), '[]'::jsonb)
  FROM pages.domains d, jsonb_each(d.site) pg
  WHERE p_domain_ids IS NULL OR d.id = ANY (p_domain_ids)
  ORDER BY d.id, pg.value ->> 'created_at'
$$;

-- ── Serving: the split reads the funnel of the copy ─────────────────────────

CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text)
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
           CASE WHEN m.slug_id IS NOT NULL THEN d.site -> (m.page_id::text) -> 'slugs' -> (m.slug) ->> 'content' END AS content,
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
               'content_hash', md5(sl.s ->> 'content'),
               'content', sl.s ->> 'content',
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

-- ── Page metrics per funnel page ────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.page_stats(timestamptz);
CREATE OR REPLACE FUNCTION pages.funnel_page_stats(p_since timestamptz)
RETURNS TABLE (funnel_page_id uuid, views bigint, clicks bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT (d.site -> (h.page_id::text) ->> 'funnel_page_id')::uuid, count(*), count(l.clicked_at)
  FROM pages.hit_loads l
  JOIN pages.hits h ON h.visit_id = l.visit_id
  JOIN pages.domains d ON d.id = h.domain_id
  WHERE h.created_at >= p_since
    AND NOT h.is_bot
    AND h.page_id IS NOT NULL
    AND d.site -> (h.page_id::text) ->> 'funnel_page_id' ~ '^[0-9a-f-]{36}$'
  GROUP BY 1
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.funnel_for(uuid)',
    'pages.funnel_page_add(uuid, text, jsonb, text)',
    'pages.funnel_page_save(uuid, uuid, text, text, text, text, text, text)',
    'pages.funnel_page_remove(uuid, uuid)',
    'pages.funnel_set_weights(uuid, jsonb)',
    'pages.funnel_page_find(uuid)',
    'pages.funnel_slug_create(uuid, uuid, text, text, text)',
    'pages.funnel_slug_rename(uuid, uuid, text, text)',
    'pages.funnel_slug_set_active(uuid, uuid, text, boolean)',
    'pages.funnel_slug_delete(uuid, uuid, text)',
    'pages.funnel_pages_summary(uuid[])',
    'pages.funnel_slug_get(uuid, uuid, text)',
    'pages.funnel_domains(uuid)',
    'pages.domain_funnel_copy(uuid, uuid)',
    'pages.domain_pages_summary(uuid[])',
    'pages.funnel_page_stats(timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION pages.funnels_site_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.resolve(text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
