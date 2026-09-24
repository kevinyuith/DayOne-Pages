-- ============================================================================
-- DayOne Pages — A/B test between the pages of a funnel
--
-- A funnel (dayone-main, pages.pages.funnel_id) can have several pages; they
-- compete for the funnel's traffic on the same URL:
--
-- 1. pages.pages.traffic_weight (0-100, default 100): the page's weight in its
--    funnel's split, edited on the Funnel screen. 0 = paused. It is read live:
--    the domain copies follow it (it is not copied).
--
-- 2. pages.resolve gets a `split` column: when the page a SERVE route resolves
--    to is a copy of a funnel page, and the domain has other PUBLISHED copies
--    of pages of the same funnel with an active slug at the same path, `split`
--    lists all of them (page_id, slug_id, content_type, content_hash, content,
--    weight). The delivery server picks one per visitor, sticky in a cookie.
--    NULL = no split. Changing a RETURNS TABLE needs DROP + CREATE; the old
--    delivery server ignores the extra column.
--
-- 3. Page metrics: pages.hit_loads.clicked_at — the load beacon now also says
--    when the visitor clicked out of the page (a link or data-href that
--    navigates). pages.log_click records it (server key, like log_load).
--    pages.page_stats(p_since) adds up, per library page (the template of the
--    domain copy that was served), real loads (views) and loads that clicked
--    out (clicks), bots excluded.
-- ============================================================================

-- ── 1. Weight ───────────────────────────────────────────────────────────────

ALTER TABLE pages.pages ADD COLUMN IF NOT EXISTS traffic_weight smallint NOT NULL DEFAULT 100;
ALTER TABLE pages.pages DROP CONSTRAINT IF EXISTS ck_pages_traffic_weight;
ALTER TABLE pages.pages ADD CONSTRAINT ck_pages_traffic_weight CHECK (traffic_weight BETWEEN 0 AND 100);
COMMENT ON COLUMN pages.pages.traffic_weight IS 'Weight (0-100) of this page in its funnel''s A/B split between pages; 0 = paused. Read live by pages.resolve for the domain copies.';

-- ── 2. resolve with the split ───────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.resolve(text, text, text);
CREATE FUNCTION pages.resolve(p_host text, p_path text, p_key text)
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
    -- The funnel of the resolved page's template, if any.
    LEFT JOIN LATERAL (
      SELECT t.funnel_id
      FROM pages.pages t
      WHERE m.slug_id IS NOT NULL
        AND t.id::text = d.site -> (m.page_id::text) ->> 'template_id'
        AND t.funnel_id IS NOT NULL
    ) f ON true
    -- Every published copy of a page of that funnel with an active slug at this path.
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'page_id', pg.key,
               'slug_id', md5(d.id::text || ':' || pg.key || ':' || m.slug)::uuid,
               'content_type', coalesce(sl.s ->> 'content_type', 'text/html; charset=utf-8'),
               'content_hash', md5(sl.s ->> 'content'),
               'content', sl.s ->> 'content',
               'weight', t.traffic_weight)
             ORDER BY pg.value ->> 'created_at', pg.key) AS split
      FROM jsonb_each(d.site) pg
      JOIN pages.pages t ON t.id::text = pg.value ->> 'template_id' AND t.funnel_id = f.funnel_id
      CROSS JOIN LATERAL (SELECT pg.value -> 'slugs' -> (m.slug) AS s) sl
      WHERE f.funnel_id IS NOT NULL
        AND pg.value ->> 'status' = 'PUBLISHED'
        AND coalesce((sl.s ->> 'is_active')::boolean, false)
      HAVING count(*) > 1
    ) sp ON true;
END $function$;

REVOKE ALL ON FUNCTION pages.resolve(text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text) TO anon, service_role;

-- ── 3. Clicks and page metrics ──────────────────────────────────────────────

ALTER TABLE pages.hit_loads ADD COLUMN IF NOT EXISTS clicked_at timestamptz;
COMMENT ON COLUMN pages.hit_loads.clicked_at IS 'When the visitor first clicked out of the page (a link or data-href that navigates); NULL = no click.';

CREATE INDEX IF NOT EXISTS idx_pages_hits_visit ON pages.hits (visit_id) WHERE visit_id IS NOT NULL;

-- Called by the delivery server after the response is gone. A click before
-- the load notice still counts as a load.
CREATE OR REPLACE FUNCTION pages.log_click(p_key text, p_visit_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.log_click: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_visit_id, '') !~ '^[0-9a-f]{32}$' THEN
    RETURN;
  END IF;

  INSERT INTO pages.hit_loads (visit_id, clicked_at)
  VALUES (p_visit_id, now())
  ON CONFLICT (visit_id) DO UPDATE SET clicked_at = coalesce(pages.hit_loads.clicked_at, excluded.clicked_at);
END $function$;

REVOKE ALL ON FUNCTION pages.log_click(text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_click(text, text) TO anon, service_role;

-- Per library page: loads of its domain copies since p_since (views) and how
-- many of them clicked out (clicks). Bots excluded.
CREATE OR REPLACE FUNCTION pages.page_stats(p_since timestamptz)
RETURNS TABLE (template_id uuid, views bigint, clicks bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT (d.site -> (h.page_id::text) ->> 'template_id')::uuid, count(*), count(l.clicked_at)
  FROM pages.hit_loads l
  JOIN pages.hits h ON h.visit_id = l.visit_id
  JOIN pages.domains d ON d.id = h.domain_id
  WHERE h.created_at >= p_since
    AND NOT h.is_bot
    AND h.page_id IS NOT NULL
    AND d.site -> (h.page_id::text) ->> 'template_id' ~ '^[0-9a-f-]{36}$'
  GROUP BY 1
$function$;

REVOKE ALL ON FUNCTION pages.page_stats(timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.page_stats(timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
