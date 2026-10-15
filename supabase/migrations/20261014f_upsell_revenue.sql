-- ============================================================================
-- DayOne Pages — the revenue of an upsell funnel's versions (the owner, 14/10/2026: the Upsells
-- screen shows what each page version, offer and route earns, over the Dashboard's periods).
--
-- The sales come from the platforms' own orders (core.orders, synced by dayone-main): every item
-- that is not the front whose offer_code is one of the vendor product's checkout values on the
-- funnel's platform. Each sale is tied to the buyer's answer on our upsell step — the dot event
-- upsell_accept / downsell_accept with the same offer code from the same IP, at most 6 hours
-- after the order's front — and takes that event's step (origin), group, flow and page version
-- (metadata.upsell). A sale with no such answer (bought through another site, or before the
-- period) is left out: the screen only counts what its own pages sold.
--
-- Read-only, for the dashboard (service_role), like upsell_funnel_stats / upsell_funnel_answers.
-- ============================================================================

CREATE FUNCTION pages.upsell_funnel_revenue(p_funnel uuid, p_since timestamptz)
RETURNS TABLE(origin text, event text, offer text, grp text, flow text, page text, sales bigint, revenue numeric)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH f AS (
    SELECT uf.page_id, vp.product_id, vp.platform, p.checkout_links -> vp.platform AS links
    FROM pages.upsell_funnels uf
    JOIN pages.page_content vp ON vp.id = uf.page_id
    LEFT JOIN pages.products p ON p.id = vp.product_id
    WHERE uf.id = p_funnel AND vp.platform IS NOT NULL
  ),
  codes AS (
    SELECT DISTINCT l.value AS code
    FROM f, jsonb_each_text(CASE WHEN jsonb_typeof(f.links) = 'object' THEN f.links ELSE '{}'::jsonb END) l
  ),
  -- The buyers' answers on this funnel's pages (the vendor page or one of its product's upsell pages).
  answers AS MATERIALIZED (
    SELECT e.origin, e.event, e.product_option AS code, host(e.ip) AS ip, e.event_at,
           e.metadata #>> '{upsell,g}' AS grp, e.metadata #>> '{upsell,fl}' AS flow, e.metadata #>> '{upsell,p}' AS page
    FROM f
    JOIN tracking.dot_events e
      ON e.event IN ('upsell_accept', 'downsell_accept')
     AND e.event_at >= p_since
     AND e.ip IS NOT NULL
     AND e.product_option IN (SELECT code FROM codes)
     AND (e.page_id = f.page_id::text
          OR e.page_id IN (SELECT up.id::text FROM pages.page_content up
                           WHERE up.scope = 'VENDOR' AND up.kind = 'UPSELL'
                             AND up.product_id IS NOT DISTINCT FROM f.product_id AND up.platform IS NOT DISTINCT FROM f.platform))
  ),
  sold AS (
    SELECT o.order_key, host(o.customer_ip::inet) AS ip, o.ordered_at, i ->> 'offer_code' AS code,
           coalesce((i ->> 'line_total')::numeric, 0) AS amount
    FROM f
    JOIN core.orders o
      ON o.platform = lower(f.platform)
     AND o.ordered_at >= p_since - interval '6 hours'
     AND pg_input_is_valid(o.customer_ip, 'inet')
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) i
    WHERE i ->> 'offer_code' IN (SELECT code FROM codes)
      AND coalesce(i ->> 'type', '') NOT IN ('front', 'OFFER')
  )
  SELECT a.origin, a.event, s.code, a.grp, a.flow, a.page, count(DISTINCT s.order_key), sum(s.amount)
  FROM sold s
  CROSS JOIN LATERAL (
    SELECT x.origin, x.event, x.grp, x.flow, x.page
    FROM answers x
    WHERE x.ip = s.ip AND x.code = s.code AND x.event_at BETWEEN s.ordered_at AND s.ordered_at + interval '6 hours'
    ORDER BY x.event_at DESC
    LIMIT 1
  ) a
  GROUP BY 1, 2, 3, 4, 5, 6
$$;
COMMENT ON FUNCTION pages.upsell_funnel_revenue(uuid, timestamptz) IS
  'An upsell funnel''s sales since p_since: the platform''s order items (core.orders, not the front) whose offer code is one of the product''s checkout values, each tied to the buyer''s accept on our pages (dot upsell_/downsell_accept, same code and IP, within 6 h of the order) — per origin, event, offer code, group, flow and page: sales (orders) and revenue (the items'' line totals). Unmatched sales are left out.';

REVOKE ALL ON FUNCTION pages.upsell_funnel_revenue(uuid, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_revenue(uuid, timestamptz) TO service_role;
