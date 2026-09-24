-- ============================================================================
-- DayOne Pages — every page lives in pages.pages, slugs and HTML included
--
-- Replaces pages.contents (20260924o) and pages.page_slugs:
--
--   pages.pages     every page: templates (scope TEMPLATE), the pages a
--                   domain serves (DOMAIN) and the pages of a funnel (FUNNEL).
--                   `slugs` holds its slugs and their HTML:
--                   { "/path": { title, content, content_type, is_active,
--                                content_hash, created_at, updated_at } }
--                   content_hash (sha256 of content) is filled by a trigger.
--                   A DOMAIN page records where it was copied from:
--                   template_id, or funnel_page_id + funnel_id (the funnel
--                   whose A/B test it takes part in on the domain).
--   domains.site    only the list of the domain's pages: { "<page id>": {} }
--   funnels.site    only the list of the funnel's pages and their share of
--                   the A/B test: { "<page id>": { "weight": 50 } }
--
-- A page belongs to exactly one domain or funnel (triggers); removing it from
-- the list deletes the row, deleting the domain or funnel deletes its pages.
-- The domain_* / funnel_* functions keep their names and results; the
-- generic page_* functions work on any page.
--
-- Serving is unchanged for the delivery server: resolve returns the same
-- columns (content_hash = sha256 of the HTML, as in 20260924o) and
-- pages.content_get now takes { page_id, slug } pairs.
-- ============================================================================

-- ── pages.pages gets the slugs ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.content_hash(p_content text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT encode(sha256(convert_to(coalesce(p_content, ''), 'UTF8')), 'hex')
$$;

ALTER TABLE pages.pages
  ADD COLUMN IF NOT EXISTS scope          text  NOT NULL DEFAULT 'TEMPLATE',
  ADD COLUMN IF NOT EXISTS slugs          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS template_id    uuid  REFERENCES pages.pages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS funnel_id      uuid  REFERENCES pages.funnels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS funnel_page_id uuid  REFERENCES pages.pages(id) ON DELETE SET NULL;

ALTER TABLE pages.pages DROP CONSTRAINT IF EXISTS ck_pages_scope;
ALTER TABLE pages.pages ADD CONSTRAINT ck_pages_scope CHECK (scope IN ('TEMPLATE', 'DOMAIN', 'FUNNEL'));
ALTER TABLE pages.pages DROP CONSTRAINT IF EXISTS pages_kind_check;
ALTER TABLE pages.pages ADD CONSTRAINT pages_kind_check
  CHECK (kind = ANY (ARRAY['PRESELL', 'ADVERTORIAL', 'VSL', 'CHECKOUT', 'SAFE', 'OTHER', 'FUNNEL']));
-- A template is never FUNNEL; a funnel page always is.
ALTER TABLE pages.pages DROP CONSTRAINT IF EXISTS ck_pages_kind_scope;
ALTER TABLE pages.pages ADD CONSTRAINT ck_pages_kind_scope
  CHECK ((scope = 'TEMPLATE' AND kind <> 'FUNNEL') OR (scope = 'FUNNEL' AND kind = 'FUNNEL') OR scope = 'DOMAIN');

CREATE INDEX IF NOT EXISTS idx_pages_pages_scope    ON pages.pages (scope);
CREATE INDEX IF NOT EXISTS idx_pages_pages_template ON pages.pages (template_id);
CREATE INDEX IF NOT EXISTS idx_pages_pages_funnel   ON pages.pages (funnel_id);

COMMENT ON COLUMN pages.pages.kind IS 'Page kind. FUNNEL only for funnel pages and their copies on domains.';
COMMENT ON COLUMN pages.pages.scope IS 'TEMPLATE (Templates screen, never served), DOMAIN (listed in exactly one domains.site) or FUNNEL (listed in exactly one funnels.site).';
COMMENT ON COLUMN pages.pages.slugs IS '{ "/path": { title, content, content_type, is_active, content_hash, created_at, updated_at } }. content_hash = sha256 of content, set by trigger. Never select * from pages: this column carries the HTML.';
COMMENT ON COLUMN pages.pages.template_id IS 'DOMAIN page copied from this template.';
COMMENT ON COLUMN pages.pages.funnel_id IS 'DOMAIN page copied from a page of this funnel: it takes part in the funnel''s A/B test on the domain.';
COMMENT ON COLUMN pages.pages.funnel_page_id IS 'DOMAIN page copied from this funnel page (its weight in funnels.site is the copy''s share).';

-- Validates and normalizes every slug; fills content_hash and the defaults.
CREATE OR REPLACE FUNCTION pages.pages_slugs_fill()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  sl  record;
  out jsonb := '{}'::jsonb;
BEGIN
  IF coalesce(jsonb_typeof(NEW.slugs), '') <> 'object' THEN
    RAISE EXCEPTION 'pages.slugs must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR sl IN SELECT key, value FROM jsonb_each(NEW.slugs) LOOP
    IF sl.key !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$'
       OR coalesce(jsonb_typeof(sl.value), '') <> 'object'
       OR coalesce(jsonb_typeof(sl.value -> 'content'), '') <> 'string'
       OR coalesce(jsonb_typeof(sl.value -> 'is_active'), 'boolean') <> 'boolean' THEN
      RAISE EXCEPTION 'pages.slugs: invalid slug % in page %', sl.key, NEW.id USING ERRCODE = 'check_violation';
    END IF;
    out := out || jsonb_build_object(sl.key, jsonb_build_object(
      'title', CASE WHEN jsonb_typeof(sl.value -> 'title') = 'string' AND btrim(sl.value ->> 'title') <> ''
                    THEN sl.value -> 'title' ELSE 'null'::jsonb END,
      'content', sl.value -> 'content',
      'content_type', coalesce(sl.value -> 'content_type', '"text/html; charset=utf-8"'::jsonb),
      'is_active', coalesce(sl.value -> 'is_active', 'true'::jsonb),
      'content_hash', to_jsonb(pages.content_hash(sl.value ->> 'content')),
      'created_at', coalesce(sl.value -> 'created_at', to_jsonb(now())),
      'updated_at', coalesce(sl.value -> 'updated_at', to_jsonb(now()))));
  END LOOP;
  NEW.slugs := out;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_pages_slugs_fill ON pages.pages;
CREATE TRIGGER trg_pages_pages_slugs_fill BEFORE INSERT OR UPDATE OF slugs ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION pages.pages_slugs_fill();

-- ── Move the data ───────────────────────────────────────────────────────────

-- Templates: page_slugs -> slugs (updated_at of the templates kept).
ALTER TABLE pages.pages DISABLE TRIGGER trg_pages_pages_updated_at;
UPDATE pages.pages p
SET slugs = coalesce((
  SELECT jsonb_object_agg(s.slug, jsonb_build_object(
           'title', s.title, 'content', coalesce(s.content, ''), 'content_type', s.content_type,
           'is_active', s.is_active, 'created_at', s.created_at, 'updated_at', s.updated_at))
  FROM pages.page_slugs s WHERE s.page_id = p.id), '{}'::jsonb);
ALTER TABLE pages.pages ENABLE TRIGGER trg_pages_pages_updated_at;

-- The HTML of a site slug object written by 20260924o (content_id -> pages.contents).
CREATE OR REPLACE FUNCTION pages.tmp_site_slugs(p_slugs jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_object_agg(sl.key, jsonb_build_object(
           'title', sl.value -> 'title',
           'content', coalesce(sl.value ->> 'content', (SELECT c.content FROM pages.contents c WHERE c.id = sl.value ->> 'content_id'), ''),
           'content_type', sl.value -> 'content_type', 'is_active', sl.value -> 'is_active',
           'created_at', sl.value -> 'created_at', 'updated_at', sl.value -> 'updated_at')), '{}'::jsonb)
  FROM jsonb_each(p_slugs) sl
$$;

-- Funnel pages.
INSERT INTO pages.pages (id, scope, name, kind, status, notes, slugs, created_at, updated_at)
SELECT pg.key::uuid, 'FUNNEL', pg.value ->> 'name', 'FUNNEL', pg.value ->> 'status', pg.value ->> 'notes',
       pages.tmp_site_slugs(pg.value -> 'slugs'),
       coalesce((pg.value ->> 'created_at')::timestamptz, now()), coalesce((pg.value ->> 'updated_at')::timestamptz, now())
FROM pages.funnels f, jsonb_each(f.site) pg
WHERE pg.value ? 'slugs';

-- Domain pages.
INSERT INTO pages.pages (id, scope, name, kind, status, slugs, template_id, funnel_id, funnel_page_id, created_at, updated_at)
SELECT pg.key::uuid, 'DOMAIN', pg.value ->> 'name', pg.value ->> 'kind', pg.value ->> 'status',
       pages.tmp_site_slugs(pg.value -> 'slugs'),
       (SELECT t.id FROM pages.pages t WHERE t.id::text = pg.value ->> 'template_id' AND t.scope = 'TEMPLATE'),
       (SELECT fu.id FROM pages.funnels fu WHERE fu.id::text = pg.value ->> 'funnel_id'),
       (SELECT fp.id FROM pages.pages fp WHERE fp.id::text = pg.value ->> 'funnel_page_id' AND fp.scope = 'FUNNEL'),
       coalesce((pg.value ->> 'created_at')::timestamptz, now()), coalesce((pg.value ->> 'updated_at')::timestamptz, now())
FROM pages.domains d, jsonb_each(d.site) pg
WHERE pg.value ? 'slugs';

DROP FUNCTION pages.tmp_site_slugs(jsonb);

-- The lists now.
CREATE OR REPLACE FUNCTION pages.domains_site_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  pg record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.site), '') <> 'object' THEN
    RAISE EXCEPTION 'domains.site must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR pg IN SELECT key, value FROM jsonb_each(NEW.site) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object' THEN
      RAISE EXCEPTION 'domains.site: invalid entry %', pg.key USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pages.pages p WHERE p.id = pg.key::uuid AND p.scope = 'DOMAIN') THEN
      RAISE EXCEPTION 'domains.site: % is not a domain page', pg.key USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM pages.domains o WHERE o.id <> NEW.id AND o.site ? pg.key) THEN
      RAISE EXCEPTION 'domains.site: page % belongs to another domain', pg.key USING ERRCODE = 'unique_violation';
    END IF;
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
BEGIN
  IF coalesce(jsonb_typeof(NEW.site), '') <> 'object' THEN
    RAISE EXCEPTION 'funnels.site must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR pg IN SELECT key, value FROM jsonb_each(NEW.site) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object'
       OR coalesce(pg.value ->> 'weight', '') !~ '^\d{1,3}$'
       OR (pg.value ->> 'weight')::int > 100 THEN
      RAISE EXCEPTION 'funnels.site: invalid entry %', pg.key USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pages.pages p WHERE p.id = pg.key::uuid AND p.scope = 'FUNNEL') THEN
      RAISE EXCEPTION 'funnels.site: % is not a funnel page', pg.key USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM pages.funnels o WHERE o.id <> NEW.id AND o.site ? pg.key) THEN
      RAISE EXCEPTION 'funnels.site: page % belongs to another funnel', pg.key USING ERRCODE = 'unique_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

UPDATE pages.funnels f
SET site = coalesce((SELECT jsonb_object_agg(pg.key, jsonb_build_object('weight', coalesce((pg.value ->> 'weight')::int, 0)))
                     FROM jsonb_each(f.site) pg), '{}'::jsonb)
WHERE f.site <> '{}'::jsonb;

UPDATE pages.domains d
SET site = coalesce((SELECT jsonb_object_agg(pg.key, '{}'::jsonb) FROM jsonb_each(d.site) pg), '{}'::jsonb)
WHERE d.site <> '{}'::jsonb;

COMMENT ON COLUMN pages.domains.site IS 'The pages this domain serves: { "<pages.pages id>": {} }. The pages (slugs, HTML) live in pages.pages.';
COMMENT ON COLUMN pages.funnels.site IS 'The pages of this funnel and their share of its A/B test: { "<pages.pages id>": { "weight": 0-100 } } (they add up to 100). The pages live in pages.pages.';

-- ── What goes away ──────────────────────────────────────────────────────────

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'dayone-pages-contents-gc';
DROP FUNCTION IF EXISTS pages.contents_gc(interval);
DROP FUNCTION IF EXISTS pages.content_get(text[], text);
DROP FUNCTION IF EXISTS pages.content_put(text);
DROP TABLE IF EXISTS pages.contents;
DROP FUNCTION IF EXISTS pages.content_id(text);
DROP FUNCTION IF EXISTS pages.template_as_site_page(uuid);
DROP TABLE IF EXISTS pages.page_slugs;
DROP FUNCTION IF EXISTS pages.page_slugs_normalize();

-- ── Ownership ───────────────────────────────────────────────────────────────

-- A page still listed by a domain or a funnel cannot be deleted on its own.
CREATE OR REPLACE FUNCTION pages.pages_delete_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pages.domains d WHERE d.site ? OLD.id::text)
     OR EXISTS (SELECT 1 FROM pages.funnels f WHERE f.site ? OLD.id::text) THEN
    RAISE EXCEPTION 'pages: page % is still listed by a domain or funnel', OLD.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_pages_pages_delete_check ON pages.pages;
CREATE TRIGGER trg_pages_pages_delete_check BEFORE DELETE ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION pages.pages_delete_check();

-- Deleting a domain or a funnel deletes its pages.
CREATE OR REPLACE FUNCTION pages.site_owner_deleted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  DELETE FROM pages.pages p WHERE OLD.site ? p.id::text;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_pages_domains_pages_deleted ON pages.domains;
CREATE TRIGGER trg_pages_domains_pages_deleted AFTER DELETE ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.site_owner_deleted();
DROP TRIGGER IF EXISTS trg_pages_funnels_pages_deleted ON pages.funnels;
CREATE TRIGGER trg_pages_funnels_pages_deleted AFTER DELETE ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.site_owner_deleted();

-- ── Any page: save, slugs, reads ────────────────────────────────────────────

-- Zero rows back = conflict (updated_at differs) or the page/slug is gone.
CREATE OR REPLACE FUNCTION pages.page_save(
  p_page uuid, p_name text, p_kind text, p_status text, p_expected_page_updated_at text,
  p_slug text DEFAULT NULL, p_content text DEFAULT NULL, p_expected_slug_updated_at text DEFAULT NULL
)
RETURNS TABLE (page_updated_at text, slug_updated_at text, content_hash text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_page  pages.pages%ROWTYPE;
  v_slugs jsonb;
  v_now   jsonb := to_jsonb(now());
BEGIN
  SELECT * INTO v_page FROM pages.pages p WHERE p.id = p_page FOR UPDATE;
  IF NOT FOUND OR v_page.updated_at IS DISTINCT FROM p_expected_page_updated_at::timestamptz THEN
    RETURN;
  END IF;
  v_slugs := v_page.slugs;
  IF p_slug IS NOT NULL THEN
    IF v_slugs -> p_slug IS NULL OR (v_slugs -> p_slug ->> 'updated_at') IS DISTINCT FROM p_expected_slug_updated_at THEN
      RETURN;
    END IF;
    v_slugs := jsonb_set(v_slugs, ARRAY[p_slug], (v_slugs -> p_slug) || jsonb_build_object('content', coalesce(p_content, ''), 'updated_at', v_now));
  END IF;
  UPDATE pages.pages p SET name = p_name, kind = p_kind, status = p_status, slugs = v_slugs
  WHERE p.id = p_page
  RETURNING p.slugs INTO v_slugs;
  RETURN QUERY SELECT v_now #>> '{}',
                      CASE WHEN p_slug IS NOT NULL THEN v_now #>> '{}' END,
                      CASE WHEN p_slug IS NOT NULL THEN v_slugs -> p_slug ->> 'content_hash' END;
END $$;

CREATE OR REPLACE FUNCTION pages.page_slug_create(p_page uuid, p_slug text, p_title text, p_content text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_slug  text := pages.normalize_path(p_slug);
  v_slugs jsonb;
BEGIN
  IF v_slug !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' THEN
    RAISE EXCEPTION 'page_slug_create: invalid slug %', v_slug USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.slugs INTO v_slugs FROM pages.pages p WHERE p.id = p_page FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'page_slug_create: page not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_slugs ? v_slug THEN
    RAISE EXCEPTION 'page_slug_create: slug % already exists', v_slug USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE pages.pages p
  SET slugs = p.slugs || jsonb_build_object(v_slug, jsonb_build_object('title', p_title, 'content', coalesce(p_content, ''), 'is_active', true))
  WHERE p.id = p_page;
  RETURN v_slug;
END $$;

-- A slug a domain route points at is not renamed nor deleted (23503).
CREATE OR REPLACE FUNCTION pages.page_slug_rename(p_page uuid, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_new   text := pages.normalize_path(p_new);
  v_slugs jsonb;
BEGIN
  IF v_new !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' THEN
    RAISE EXCEPTION 'page_slug_rename: invalid slug %', v_new USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.slugs INTO v_slugs FROM pages.pages p WHERE p.id = p_page FOR UPDATE;
  IF v_slugs IS NULL OR NOT (v_slugs ? p_old) THEN
    RAISE EXCEPTION 'page_slug_rename: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_new = p_old THEN
    RETURN v_new;
  END IF;
  IF v_slugs ? v_new THEN
    RAISE EXCEPTION 'page_slug_rename: slug % already exists', v_new USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM pages.domain_routes r WHERE r.page_id = p_page AND r.slug = p_old) THEN
    RAISE EXCEPTION 'page_slug_rename: a domain route points at %', p_old USING ERRCODE = 'foreign_key_violation';
  END IF;
  UPDATE pages.pages p
  SET slugs = (p.slugs - p_old) || jsonb_build_object(v_new, (p.slugs -> p_old) || jsonb_build_object('updated_at', now()))
  WHERE p.id = p_page;
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION pages.page_slug_set_active(p_page uuid, p_slug text, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.pages p
  SET slugs = jsonb_set(p.slugs, ARRAY[p_slug, 'is_active'], to_jsonb(p_active))
  WHERE p.id = p_page AND p.slugs ? p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'page_slug_set_active: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- The last slug of a page is not deleted (23514).
CREATE OR REPLACE FUNCTION pages.page_slug_delete(p_page uuid, p_slug text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_slugs jsonb;
BEGIN
  SELECT p.slugs INTO v_slugs FROM pages.pages p WHERE p.id = p_page FOR UPDATE;
  IF v_slugs IS NULL OR NOT (v_slugs ? p_slug) THEN
    RAISE EXCEPTION 'page_slug_delete: slug not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_slugs)) <= 1 THEN
    RAISE EXCEPTION 'page_slug_delete: the page needs at least one slug' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM pages.domain_routes r WHERE r.page_id = p_page AND r.slug = p_slug) THEN
    RAISE EXCEPTION 'page_slug_delete: a domain route points at %', p_slug USING ERRCODE = 'foreign_key_violation';
  END IF;
  UPDATE pages.pages p SET slugs = p.slugs - p_slug WHERE p.id = p_page;
END $$;

CREATE OR REPLACE FUNCTION pages.page_slug_get(p_page uuid, p_slug text)
RETURNS TABLE (content text, content_type text, title text, is_active boolean, content_hash text, created_at text, updated_at text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT x.s ->> 'content', x.s ->> 'content_type', x.s ->> 'title', (x.s ->> 'is_active')::boolean,
         x.s ->> 'content_hash', x.s ->> 'created_at', x.s ->> 'updated_at'
  FROM (SELECT p.slugs -> p_slug AS s FROM pages.pages p WHERE p.id = p_page) x
  WHERE x.s IS NOT NULL
$$;

-- The slugs of a page without the HTML.
CREATE OR REPLACE FUNCTION pages.slugs_summary(p_slugs jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'slug', sl.key, 'title', sl.value -> 'title', 'is_active', sl.value -> 'is_active',
           'content_type', sl.value -> 'content_type', 'content_hash', sl.value -> 'content_hash',
           'created_at', sl.value -> 'created_at', 'updated_at', sl.value -> 'updated_at')
         ORDER BY sl.key), '[]'::jsonb)
  FROM jsonb_each(p_slugs) sl
$$;

-- Pages without the HTML. p_ids / p_scope NULL = no filter.
CREATE OR REPLACE FUNCTION pages.pages_summary(p_ids uuid[] DEFAULT NULL, p_scope text DEFAULT NULL)
RETURNS TABLE (id uuid, scope text, name text, kind text, status text, notes text, folder_id uuid,
               template_id uuid, funnel_id uuid, funnel_page_id uuid, created_at text, updated_at text, slugs jsonb)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p.id, p.scope, p.name, p.kind, p.status, p.notes, p.folder_id, p.template_id, p.funnel_id, p.funnel_page_id,
         to_jsonb(p.created_at) #>> '{}', to_jsonb(p.updated_at) #>> '{}', pages.slugs_summary(p.slugs)
  FROM pages.pages p
  WHERE (p_ids IS NULL OR p.id = ANY (p_ids)) AND (p_scope IS NULL OR p.scope = p_scope)
  ORDER BY p.updated_at DESC
$$;

-- A DOMAIN copy of a template or of a funnel page (new id, same slugs and HTML).
CREATE OR REPLACE FUNCTION pages.page_copy_for_domain(p_source uuid, p_status text DEFAULT 'PUBLISHED')
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO pages.pages (scope, name, kind, status, slugs, template_id, funnel_id, funnel_page_id)
  SELECT 'DOMAIN', s.name, s.kind, p_status,
         coalesce((SELECT jsonb_object_agg(sl.key, sl.value - 'created_at' - 'updated_at') FROM jsonb_each(s.slugs) sl), '{}'::jsonb),
         CASE WHEN s.scope = 'TEMPLATE' THEN s.id END,
         CASE WHEN s.scope = 'FUNNEL' THEN (SELECT f.id FROM pages.funnels f WHERE f.site ? s.id::text) END,
         CASE WHEN s.scope = 'FUNNEL' THEN s.id END
  FROM pages.pages s
  WHERE s.id = p_source AND s.scope IN ('TEMPLATE', 'FUNNEL')
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'page_copy_for_domain: template or funnel page not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_id;
END $$;

-- ── Domain pages (same names and results as before) ─────────────────────────

CREATE OR REPLACE FUNCTION pages.domain_has_page(p_domain uuid, p_page uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM pages.domains d WHERE d.id = p_domain AND d.site ? p_page::text)
$$;

CREATE OR REPLACE FUNCTION pages.domain_pages_summary(p_domain_ids uuid[] DEFAULT NULL)
RETURNS TABLE (domain_id uuid, page_id uuid, name text, kind text, status text, template_id uuid, funnel_page_id uuid,
               created_at text, updated_at text, slugs jsonb)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT d.id, p.id, p.name, p.kind, p.status, p.template_id, p.funnel_page_id,
         to_jsonb(p.created_at) #>> '{}', to_jsonb(p.updated_at) #>> '{}', pages.slugs_summary(p.slugs)
  FROM pages.domains d
  CROSS JOIN LATERAL jsonb_object_keys(d.site) k
  JOIN pages.pages p ON p.id = k::uuid
  WHERE p_domain_ids IS NULL OR d.id = ANY (p_domain_ids)
  ORDER BY d.id, p.created_at
$$;

CREATE OR REPLACE FUNCTION pages.domain_page_save(
  p_domain uuid, p_page uuid, p_name text, p_kind text, p_status text, p_expected_page_updated_at text,
  p_slug text DEFAULT NULL, p_content text DEFAULT NULL, p_expected_slug_updated_at text DEFAULT NULL
)
RETURNS TABLE (page_updated_at text, slug_updated_at text, content_hash text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.domain_has_page(p_domain, p_page) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM pages.page_save(p_page, p_name, p_kind, p_status, p_expected_page_updated_at,
                                              p_slug, p_content, p_expected_slug_updated_at);
END $$;

CREATE OR REPLACE FUNCTION pages.domain_slug_create(p_domain uuid, p_page uuid, p_slug text, p_title text, p_content text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.domain_has_page(p_domain, p_page) THEN
    RAISE EXCEPTION 'domain_slug_create: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN pages.page_slug_create(p_page, p_slug, p_title, p_content);
END $$;

CREATE OR REPLACE FUNCTION pages.domain_slug_rename(p_domain uuid, p_page uuid, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.domain_has_page(p_domain, p_page) THEN
    RAISE EXCEPTION 'domain_slug_rename: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN pages.page_slug_rename(p_page, p_old, p_new);
END $$;

CREATE OR REPLACE FUNCTION pages.domain_slug_set_active(p_domain uuid, p_page uuid, p_slug text, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.domain_has_page(p_domain, p_page) THEN
    RAISE EXCEPTION 'domain_slug_set_active: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pages.page_slug_set_active(p_page, p_slug, p_active);
END $$;

CREATE OR REPLACE FUNCTION pages.domain_slug_delete(p_domain uuid, p_page uuid, p_slug text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.domain_has_page(p_domain, p_page) THEN
    RAISE EXCEPTION 'domain_slug_delete: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pages.page_slug_delete(p_page, p_slug);
END $$;

CREATE OR REPLACE FUNCTION pages.domain_slug_get(p_domain uuid, p_page uuid, p_slug text)
RETURNS TABLE (content text, content_type text, title text, is_active boolean, created_at text, updated_at text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT g.content, g.content_type, g.title, g.is_active, g.created_at, g.updated_at
  FROM pages.page_slug_get(p_page, p_slug) g
  WHERE pages.domain_has_page(p_domain, p_page)
$$;

-- Adds a page to the domain's list; a domain without a default page gets it.
CREATE OR REPLACE FUNCTION pages.domain_list_page(p_domain uuid, p_page uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.domains d
  SET site = d.site || jsonb_build_object(p_page::text, '{}'::jsonb),
      default_page_id = coalesce(d.default_page_id, p_page)
  WHERE d.id = p_domain;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pages.domain_page_copy(p_domain uuid, p_template uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pages.pages t WHERE t.id = p_template AND t.scope = 'TEMPLATE') THEN
    RAISE EXCEPTION 'domain_page_copy: template not found' USING ERRCODE = 'no_data_found';
  END IF;
  v_id := pages.page_copy_for_domain(p_template);
  PERFORM pages.domain_list_page(p_domain, v_id);
  RETURN v_id;
END $$;

-- A copy of the template with some slugs' HTML replaced (p_contents: { "/path": "<html>" }).
CREATE OR REPLACE FUNCTION pages.domain_page_add(p_domain uuid, p_template uuid, p_name text, p_contents jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id    uuid;
  v_slugs jsonb;
  r       record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pages.pages t WHERE t.id = p_template AND t.scope = 'TEMPLATE') THEN
    RAISE EXCEPTION 'domain_page_add: template not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF coalesce(jsonb_typeof(p_contents), '') <> 'object' THEN
    RAISE EXCEPTION 'domain_page_add: contents must be an object' USING ERRCODE = 'check_violation';
  END IF;
  v_id := pages.page_copy_for_domain(p_template);
  SELECT p.slugs INTO v_slugs FROM pages.pages p WHERE p.id = v_id;
  FOR r IN SELECT key, value FROM jsonb_each_text(p_contents) LOOP
    IF v_slugs ? r.key THEN
      v_slugs := jsonb_set(v_slugs, ARRAY[r.key, 'content'], to_jsonb(r.value));
    END IF;
  END LOOP;
  UPDATE pages.pages p SET slugs = v_slugs, name = coalesce(nullif(btrim(p_name), ''), p.name) WHERE p.id = v_id;
  PERFORM pages.domain_list_page(p_domain, v_id);
  RETURN v_id;
END $$;

-- "Change template": same id and status, the template's slugs and HTML (edits lost).
CREATE OR REPLACE FUNCTION pages.domain_page_replace(p_domain uuid, p_page uuid, p_template uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.domain_has_page(p_domain, p_page) THEN
    RAISE EXCEPTION 'domain_page_replace: domain page not found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE pages.pages p
  SET name = t.name, kind = t.kind, template_id = t.id, funnel_id = NULL, funnel_page_id = NULL,
      slugs = coalesce((SELECT jsonb_object_agg(sl.key, sl.value - 'created_at' - 'updated_at') FROM jsonb_each(t.slugs) sl), '{}'::jsonb)
  FROM pages.pages t
  WHERE p.id = p_page AND t.id = p_template AND t.scope = 'TEMPLATE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_page_replace: template not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

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
  DELETE FROM pages.pages WHERE id = p_page;
END $$;

-- Copies every non-archived page of the funnel into the domain (PUBLISHED).
CREATE OR REPLACE FUNCTION pages.domain_funnel_copy(p_domain uuid, p_funnel uuid)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_n  int := 0;
  pg   record;
BEGIN
  FOR pg IN
    SELECT p.id FROM pages.funnels f
    CROSS JOIN LATERAL jsonb_object_keys(f.site) k
    JOIN pages.pages p ON p.id = k::uuid
    WHERE f.id = p_funnel AND p.status <> 'ARCHIVED'
    ORDER BY p.created_at, p.id
  LOOP
    PERFORM pages.domain_list_page(p_domain, pages.page_copy_for_domain(pg.id));
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- ── Funnel pages (same names and results as before) ─────────────────────────

CREATE OR REPLACE FUNCTION pages.funnel_has_page(p_funnel uuid, p_page uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM pages.funnels f WHERE f.id = p_funnel AND f.site ? p_page::text)
$$;

-- Adds a page (DRAFT, weight 100 — the dashboard rebalances right after).
-- p_slugs: { "/path": { "title": ..., "content": ..., "content_type": ..., "is_active": ... } }.
CREATE OR REPLACE FUNCTION pages.funnel_page_add(p_funnel uuid, p_name text, p_slugs jsonb, p_notes text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF coalesce(jsonb_typeof(p_slugs), '') <> 'object' OR p_slugs = '{}'::jsonb THEN
    RAISE EXCEPTION 'funnel_page_add: slugs must be a non-empty object' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO pages.pages (scope, name, kind, status, notes, slugs)
  VALUES ('FUNNEL', btrim(p_name), 'FUNNEL', 'DRAFT', p_notes,
          (SELECT jsonb_object_agg(pages.normalize_path(s.key), s.value) FROM jsonb_each(p_slugs) s))
  RETURNING id INTO v_id;
  UPDATE pages.funnels f SET site = f.site || jsonb_build_object(v_id::text, jsonb_build_object('weight', 100)) WHERE f.id = p_funnel;
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
BEGIN
  IF NOT pages.funnel_has_page(p_funnel, p_page) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM pages.page_save(p_page, p_name, 'FUNNEL', p_status, p_expected_page_updated_at,
                                              p_slug, p_content, p_expected_slug_updated_at);
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
  DELETE FROM pages.pages WHERE id = p_page;
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_create(p_funnel uuid, p_page uuid, p_slug text, p_title text, p_content text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.funnel_has_page(p_funnel, p_page) THEN
    RAISE EXCEPTION 'funnel_slug_create: funnel page not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN pages.page_slug_create(p_page, p_slug, p_title, p_content);
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_rename(p_funnel uuid, p_page uuid, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.funnel_has_page(p_funnel, p_page) THEN
    RAISE EXCEPTION 'funnel_slug_rename: funnel page not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN pages.page_slug_rename(p_page, p_old, p_new);
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_set_active(p_funnel uuid, p_page uuid, p_slug text, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.funnel_has_page(p_funnel, p_page) THEN
    RAISE EXCEPTION 'funnel_slug_set_active: funnel page not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pages.page_slug_set_active(p_page, p_slug, p_active);
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_delete(p_funnel uuid, p_page uuid, p_slug text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.funnel_has_page(p_funnel, p_page) THEN
    RAISE EXCEPTION 'funnel_slug_delete: funnel page not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pages.page_slug_delete(p_page, p_slug);
END $$;

CREATE OR REPLACE FUNCTION pages.funnel_slug_get(p_funnel uuid, p_page uuid, p_slug text)
RETURNS TABLE (content text, content_type text, title text, is_active boolean, created_at text, updated_at text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT g.content, g.content_type, g.title, g.is_active, g.created_at, g.updated_at
  FROM pages.page_slug_get(p_page, p_slug) g
  WHERE pages.funnel_has_page(p_funnel, p_page)
$$;

CREATE OR REPLACE FUNCTION pages.funnel_pages_summary(p_funnel_ids uuid[] DEFAULT NULL)
RETURNS TABLE (funnel_id uuid, main_funnel_id uuid, page_id uuid, name text, status text, weight int, notes text,
               created_at text, updated_at text, slugs jsonb)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.id, f.main_funnel_id, p.id, p.name, p.status, (f.site -> p.id::text ->> 'weight')::int, p.notes,
         to_jsonb(p.created_at) #>> '{}', to_jsonb(p.updated_at) #>> '{}', pages.slugs_summary(p.slugs)
  FROM pages.funnels f
  CROSS JOIN LATERAL jsonb_object_keys(f.site) k
  JOIN pages.pages p ON p.id = k::uuid
  WHERE p_funnel_ids IS NULL OR f.id = ANY (p_funnel_ids)
  ORDER BY f.id, p.created_at, p.id
$$;

-- The domains that have a copy of a page of the funnel (to purge their cache).
CREATE OR REPLACE FUNCTION pages.funnel_domains(p_funnel uuid)
RETURNS TABLE (domain_id uuid, domain text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT DISTINCT d.id, d.domain
  FROM pages.domains d
  CROSS JOIN LATERAL jsonb_object_keys(d.site) k
  JOIN pages.pages p ON p.id = k::uuid
  WHERE p.funnel_id = p_funnel
$$;

CREATE OR REPLACE FUNCTION pages.funnel_page_stats(p_since timestamptz)
RETURNS TABLE (funnel_page_id uuid, views bigint, clicks bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p.funnel_page_id, count(*), count(l.clicked_at)
  FROM pages.hit_loads l
  JOIN pages.hits h ON h.visit_id = l.visit_id
  JOIN pages.pages p ON p.id = h.page_id
  WHERE h.created_at >= p_since
    AND NOT h.is_bot
    AND p.funnel_page_id IS NOT NULL
  GROUP BY 1
$$;

-- ── Serving ─────────────────────────────────────────────────────────────────

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
         CASE WHEN sl.content_hash IS NOT NULL THEN md5(c.domain_id::text || ':' || c.page_id::text || ':' || c.slug)::uuid END AS slug_id,
         sl.content_type,
         sl.content_hash,
         c.redirect_url, c.status_code, c.preserve_query
  FROM candidates c
  CROSS JOIN dom
  LEFT JOIN LATERAL (
    SELECT p.status, p.slugs -> c.slug AS s
    FROM pages.pages p
    WHERE p.id = c.page_id AND dom.site ? c.page_id::text
  ) pg ON true
  LEFT JOIN LATERAL (
    SELECT pg.s ->> 'content_hash' AS content_hash,
           coalesce(pg.s ->> 'content_type', 'text/html; charset=utf-8') AS content_type
    WHERE coalesce((pg.s ->> 'is_active')::boolean, false)
  ) sl ON true
  WHERE c.action <> 'SERVE' OR pg.status = 'PUBLISHED'
  ORDER BY c.priority
$function$;

-- p_with_content = false: ids only; the server fetches the HTML it lacks with
-- pages.content_get. Default true keeps the servers already deployed working.
CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
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
                THEN (SELECT p.slugs -> m.slug ->> 'content' FROM pages.pages p WHERE p.id = m.page_id) END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders,
           sp.split
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id
    -- The funnel of the resolved page (a copy of a funnel page), if any.
    LEFT JOIN LATERAL (
      SELECT rp.funnel_id FROM pages.pages rp
      WHERE m.slug_id IS NOT NULL AND rp.id = m.page_id AND rp.funnel_id IS NOT NULL
    ) f ON true
    -- Every published copy of a page of that funnel on this domain with an
    -- active slug at this path; the weight comes live from funnels.site
    -- (a page removed from the funnel = 0).
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'page_id', p.id,
               'slug_id', md5(d.id::text || ':' || p.id::text || ':' || m.slug)::uuid,
               'content_type', coalesce(sl.s ->> 'content_type', 'text/html; charset=utf-8'),
               'content_hash', sl.s ->> 'content_hash',
               'content', CASE WHEN p_with_content THEN sl.s ->> 'content' END,
               'weight', coalesce((fu.site -> p.funnel_page_id::text ->> 'weight')::int, 0))
             ORDER BY p.created_at, p.id) AS split
      FROM jsonb_object_keys(d.site) k
      JOIN pages.pages p ON p.id = k::uuid
      LEFT JOIN pages.funnels fu ON fu.id = p.funnel_id
      CROSS JOIN LATERAL (SELECT p.slugs -> m.slug AS s) sl
      WHERE f.funnel_id IS NOT NULL
        AND p.funnel_id = f.funnel_id
        AND p.status = 'PUBLISHED'
        AND coalesce((sl.s ->> 'is_active')::boolean, false)
      HAVING count(*) > 1
    ) sp ON true;
END $function$;

-- The HTML of the given { page_id, slug } pairs (domain pages only), for the
-- delivery server (same key as resolve).
CREATE OR REPLACE FUNCTION pages.content_get(p_refs jsonb, p_key text)
RETURNS TABLE (page_id uuid, slug text, content_hash text, content text)
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
  IF coalesce(jsonb_typeof(p_refs), '') <> 'array' OR jsonb_array_length(p_refs) > 50 THEN
    RAISE EXCEPTION 'pages.content_get: refs must be an array of at most 50 { page_id, slug }' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT p.id, r.slug, p.slugs -> r.slug ->> 'content_hash', p.slugs -> r.slug ->> 'content'
    FROM jsonb_to_recordset(p_refs) AS r(page_id uuid, slug text)
    JOIN pages.pages p ON p.id = r.page_id AND p.scope = 'DOMAIN'
    WHERE p.slugs ? r.slug;
END $function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.content_hash(text)',
    'pages.page_save(uuid, text, text, text, text, text, text, text)',
    'pages.page_slug_create(uuid, text, text, text)',
    'pages.page_slug_rename(uuid, text, text)',
    'pages.page_slug_set_active(uuid, text, boolean)',
    'pages.page_slug_delete(uuid, text)',
    'pages.page_slug_get(uuid, text)',
    'pages.slugs_summary(jsonb)',
    'pages.pages_summary(uuid[], text)',
    'pages.page_copy_for_domain(uuid, text)',
    'pages.domain_has_page(uuid, uuid)',
    'pages.domain_pages_summary(uuid[])',
    'pages.domain_page_save(uuid, uuid, text, text, text, text, text, text, text)',
    'pages.domain_slug_create(uuid, uuid, text, text, text)',
    'pages.domain_slug_rename(uuid, uuid, text, text)',
    'pages.domain_slug_set_active(uuid, uuid, text, boolean)',
    'pages.domain_slug_delete(uuid, uuid, text)',
    'pages.domain_slug_get(uuid, uuid, text)',
    'pages.domain_list_page(uuid, uuid)',
    'pages.domain_page_copy(uuid, uuid)',
    'pages.domain_page_add(uuid, uuid, text, jsonb)',
    'pages.domain_page_replace(uuid, uuid, uuid)',
    'pages.domain_page_remove(uuid, uuid)',
    'pages.domain_funnel_copy(uuid, uuid)',
    'pages.funnel_has_page(uuid, uuid)',
    'pages.funnel_page_add(uuid, text, jsonb, text)',
    'pages.funnel_page_save(uuid, uuid, text, text, text, text, text, text)',
    'pages.funnel_page_remove(uuid, uuid)',
    'pages.funnel_slug_create(uuid, uuid, text, text, text)',
    'pages.funnel_slug_rename(uuid, uuid, text, text)',
    'pages.funnel_slug_set_active(uuid, uuid, text, boolean)',
    'pages.funnel_slug_delete(uuid, uuid, text)',
    'pages.funnel_slug_get(uuid, uuid, text)',
    'pages.funnel_pages_summary(uuid[])',
    'pages.funnel_domains(uuid)',
    'pages.funnel_page_stats(timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION pages.pages_slugs_fill() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.pages_delete_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.site_owner_deleted() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.domains_site_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.funnels_site_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.resolve(text, text, text, boolean) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text, boolean) TO anon, service_role;
REVOKE ALL ON FUNCTION pages.content_get(jsonb, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.content_get(jsonb, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
