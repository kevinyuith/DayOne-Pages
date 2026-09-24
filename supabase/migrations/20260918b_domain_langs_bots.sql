-- ============================================================================
-- DayOne Pages — languages in the filter + per-domain bot blocking
--
-- Apply ON TOP of 20260918_domain_filter.sql. Incremental and idempotent.
--
-- What goes in:
--   1. pages.domains.block_bots — "block bots/suspicious connections" switch
--   2. match_routes() — a BLOCK (403) candidate at the TOP when block_bots
--
-- Languages and the allow/block direction of the lists (country/language) need NO
-- column or CHECK: they live inside the `filter` jsonb (keys `languages`,
-- `languages_mode`, `countries_mode`), evaluated by the serving layer. The
-- CHECK ck_domains_filter_no_bot (from 20260918) still holds: the filter never
-- carries `bot` — bot only BLOCKS, and that is what the column below does.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 1. block_bots                                                             │
-- └──────────────────────────────────────────────────────────────────────────┘

ALTER TABLE pages.domains
  ADD COLUMN IF NOT EXISTS block_bots boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pages.domains.block_bots IS
  'Blocks crawlers/automated connections (answers 403) before any route. Does not change the page — it only blocks.';


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 2. match_routes() — bot gate at the top + domain filter                  │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Only the `dom` CTE (brings block_bots) and the `candidates` CTE (a new
-- BLOCK row with priority -1, before everything) change. The rest is the same as the
-- 20260918 version. The serving layer evaluates each row's `conditions` and serves the
-- first one that passes; the bot gate only matches a bot User-Agent.
--
-- Priority order: bot gate (-1) → manual rules (0..100000) →
-- filter (2147483646) → fallback (2147483647).

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
    SELECT d.id, d.default_page_id, d.filter, d.filter_pass_page_id, d.filter_fail_page_id, d.block_bots
    FROM pages.domains d, req
    WHERE d.status = 'ACTIVE' AND d.domain = req.host
  ),
  candidates AS (
    -- 0. The domain's bot blocking: if on, a BLOCK 403 that only matches bots,
    --    before any route. It does not change the page — it blocks the connection.
    --    Being the FIRST SELECT of the CTE, it names the columns: alias on all of them.
    SELECT NULL::uuid AS route_id, dom.id AS domain_id, -1 AS priority, 'BOTGATE' AS match_type,
           NULL::text AS path_pattern, '{"bot": true}'::jsonb AS conditions, 'BLOCK' AS action,
           NULL::uuid AS page_id, NULL::text AS slug, NULL::text AS redirect_url,
           403::smallint AS status_code, false AS preserve_query
    FROM dom
    WHERE dom.block_bots

    UNION ALL
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
  'Bot gate (block_bots) + domain rules + filter + fallback, in priority order. Only matches the PATH; '
  'the `conditions` (bot gate, rules and filter) are evaluated in the serving layer. '
  'Order: bot gate (BLOCK 403 for bots only) → manual rules → filter (passed → filter_pass_page) → fallback (filter_fail_page or default_page). '
  'conditions also accepts countries_mode/languages/languages_mode; the first one whose conditions pass wins; SERVE with slug_id NULL → 404.';
