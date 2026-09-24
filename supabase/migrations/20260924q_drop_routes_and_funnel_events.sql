-- ============================================================================
-- DayOne Pages — drop pages.domain_routes and pages.funnel_events
--
-- domain_routes: per-path rules of a domain (serve another page, redirect,
-- block by conditions). Never used (0 rows, no hit ever went through one).
-- A domain now serves: bot block (block_bots) → filter (pass/fail pages) →
-- default page, with the request path as the slug.
--
-- funnel_events: view/click of each sample of a funnel step (the A/B test
-- inside a page), sent to /_dop/e. Empty; the samples are still drawn by the
-- delivery server, just without numbers. The A/B test between the pages of a
-- funnel keeps its numbers (hit_loads, funnel_page_stats).
--
-- pages.hits.route_id and log_hit's p_route_id stay (always NULL now): the
-- servers already deployed still send it.
-- ============================================================================

-- ── funnel_events ───────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.funnel_stats(uuid[], timestamptz);
DROP FUNCTION IF EXISTS pages.log_funnel_event(text, text, text, text, text, text, text);
DROP TABLE IF EXISTS pages.funnel_events;

-- ── domain_routes ───────────────────────────────────────────────────────────

DROP TABLE IF EXISTS pages.domain_routes;
DROP FUNCTION IF EXISTS pages.swap_route_priority(uuid, uuid);
DROP FUNCTION IF EXISTS pages.domain_routes_validate();
DROP FUNCTION IF EXISTS pages.domain_routes_own_page();

COMMENT ON COLUMN pages.hits.route_id IS 'Unused since domain routes were dropped (20260924q); always NULL.';

-- The domain's list: default and filter pages must be in it (no routes any more).
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

  RETURN NEW;
END $$;

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
  UPDATE pages.pages p
  SET slugs = (p.slugs - p_old) || jsonb_build_object(v_new, (p.slugs -> p_old) || jsonb_build_object('updated_at', now()))
  WHERE p.id = p_page;
  RETURN v_new;
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
  UPDATE pages.pages p SET slugs = p.slugs - p_slug WHERE p.id = p_page;
END $$;

-- What a domain serves at a path, in order: bot block → filter → default page.
-- Same result columns as before (route_id is always NULL).
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

NOTIFY pgrst, 'reload schema';
