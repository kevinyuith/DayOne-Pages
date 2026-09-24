-- ============================================================================
-- DayOne Pages — per-domain filter
--
-- A domain can have ONE filter: conditions (country, device, URL
-- parameters, referrer) and two pages — whoever PASSES sees one, whoever does NOT pass sees the other.
--
--   pages.domains.filter               jsonb with the conditions (same format as
--                                       domain_routes.conditions, EXCEPT `bot`)
--   pages.domains.filter_pass_page_id  page served when the conditions match
--   pages.domains.filter_fail_page_id  page served when they do not match
--
-- How it fits with what already exists: the manual rules (domain_routes) still
-- take priority. The filter comes right before the fallback. The evaluation order
-- in the serving layer (the first one whose conditions pass wins) becomes:
--
--   manual rules  →  filter: passed? pass page  →  fallback:
--   fail page (or, without a filter, the domain's default page)
--
-- `bot` is NOT accepted in the filter (CHECK below): bot detection is for
-- BLOCKING (domain_routes), never for changing the page served.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Columns                                                                  │
-- └──────────────────────────────────────────────────────────────────────────┘

ALTER TABLE pages.domains
  ADD COLUMN IF NOT EXISTS filter              jsonb,
  ADD COLUMN IF NOT EXISTS filter_pass_page_id uuid REFERENCES pages.pages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS filter_fail_page_id uuid REFERENCES pages.pages(id) ON DELETE SET NULL;

COMMENT ON COLUMN pages.domains.filter              IS 'Domain filter conditions (country, device, query, referrer). NULL = no filter. Does not accept the `bot` key.';
COMMENT ON COLUMN pages.domains.filter_pass_page_id IS 'Page served when the visitor passes the filter.';
COMMENT ON COLUMN pages.domains.filter_fail_page_id IS 'Page served when the visitor does not pass the filter.';

CREATE INDEX IF NOT EXISTS idx_pages_domains_filter_pass ON pages.domains (filter_pass_page_id) WHERE filter_pass_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_domains_filter_fail ON pages.domains (filter_fail_page_id) WHERE filter_fail_page_id IS NOT NULL;

-- `bot` kept out of the filter. The guarantee that does not depend on the UI.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_domains_filter_no_bot' AND conrelid = 'pages.domains'::regclass
  ) THEN
    ALTER TABLE pages.domains
      ADD CONSTRAINT ck_domains_filter_no_bot CHECK (filter IS NULL OR NOT (filter ? 'bot'));
  END IF;
END $$;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ match_routes() — now with the domain filter                              │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Only the `dom` CTE (brings the filter columns) and the `candidates` CTE (two
-- new rows) change. The rest is the same as the original. The serving layer evaluates each
-- row's `conditions` and serves the first one that passes.

CREATE OR REPLACE FUNCTION pages.match_routes(p_host text, p_path text)
RETURNS TABLE (
  route_id        uuid,
  domain_id       uuid,
  priority        integer,
  match_type      text,
  path_pattern    text,
  conditions      jsonb,
  action          text,
  page_id         uuid,
  slug            text,
  slug_id         uuid,
  content_type    text,
  content_hash    text,
  redirect_url    text,
  status_code     smallint,
  preserve_query  boolean
)
LANGUAGE sql STABLE SET search_path = '' AS $function$
  WITH req AS (
    SELECT pages.normalize_host(p_host) AS host, pages.normalize_path(p_path) AS path
  ),
  dom AS (
    SELECT d.id, d.default_page_id, d.filter, d.filter_pass_page_id, d.filter_fail_page_id
    FROM pages.domains d, req
    WHERE d.status = 'ACTIVE' AND d.domain = req.host
  ),
  candidates AS (
    -- 1. The domain's manual rules (explicit priority).
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
    -- 2. Domain filter: passed the conditions → pass page.
    --    Comes right before the fallback; only exists when there is a filter and a page.
    SELECT NULL, dom.id, 2147483646, 'FILTER', NULL, dom.filter, 'SERVE',
           dom.filter_pass_page_id, req.path, NULL, NULL, true
    FROM dom, req
    WHERE dom.filter IS NOT NULL AND dom.filter_pass_page_id IS NOT NULL

    UNION ALL
    -- 3. Fallback: the filter's fail page, otherwise the default page.
    SELECT NULL, dom.id, 2147483647, 'FALLBACK', NULL, '{}'::jsonb, 'SERVE',
           coalesce(dom.filter_fail_page_id, dom.default_page_id), req.path, NULL, NULL, true
    FROM dom, req
    WHERE coalesce(dom.filter_fail_page_id, dom.default_page_id) IS NOT NULL
  )
  SELECT c.route_id, c.domain_id, c.priority, c.match_type, c.path_pattern, c.conditions, c.action,
         c.page_id, c.slug, s.id AS slug_id, s.content_type, s.content_hash,
         c.redirect_url, c.status_code, c.preserve_query
  FROM candidates c
  LEFT JOIN pages.pages p      ON p.id = c.page_id
  LEFT JOIN pages.page_slugs s ON s.page_id = c.page_id AND s.slug = c.slug AND s.is_active
  WHERE c.action <> 'SERVE' OR p.status = 'PUBLISHED'
  ORDER BY c.priority
$function$;

COMMENT ON FUNCTION pages.match_routes(text, text) IS
  'Domain rules + filter + fallback, in priority order. Only matches the PATH; '
  'the `conditions` (rules and filter) are evaluated in the serving layer. '
  'Order: manual rules → filter (passed → filter_pass_page) → fallback (filter_fail_page or default_page). '
  'The first one whose conditions pass wins; SERVE with slug_id NULL → 404.';
