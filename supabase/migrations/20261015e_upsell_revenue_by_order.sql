-- ============================================================================
-- DayOne Pages — an upsell funnel's revenue tied by the order first, by IP only when it can't be
-- (the owner, 15/10/2026: the screen shows the exact revenue, the estimate apart).
--
-- 20261014f tied each sale (an item of the platform's order, core.orders, that is not the front and
-- whose offer code is one of the product's checkout values on the funnel's platform) to the buyer's
-- accept on our pages by the same IP within 6 h of the order's front. Since 15/10 the vendor's sales
-- also reach dot (tracking.dot_events, event vendor_purchase, origin vendor) with the platform's
-- order id and the buyer's dotid when the checkout knows it. Now each sale is tied, in order:
--   exact  the order (core.orders.platform_order_id) ↔ a vendor_purchase with that order_id ↔ an
--          accept (upsell_accept / downsell_accept) on this funnel's pages with the same dotid and
--          offer code, from 10 minutes before the order's front to 24 h after it (the dotid lives a
--          day). A dotid the vendor_purchase events of another order carry too is not the buyer's
--          (on 15/10 every vendor_purchase had the one dot mints for the checkout's server);
--   ip6h   only when it has no exact tie: today's rule — an accept with the same offer code from the
--          same IP, within 6 h after the order's front.
-- A sale is tied once (exact wins) and counted once. Each row says which (`match_kind`, the last
-- column); every other column is as before, so callers that sum the rows (core.products_upsell_get
-- in the producer dashboard) keep working. A sale with neither tie is still left out.
--
-- The output gains a column, so the function is dropped and created again (its callers are plpgsql:
-- nothing depends on it in the catalog).
-- ============================================================================

DROP FUNCTION pages.upsell_funnel_revenue(uuid, timestamptz);

CREATE FUNCTION pages.upsell_funnel_revenue(p_funnel uuid, p_since timestamptz)
RETURNS TABLE(origin text, event text, offer text, grp text, flow text, page text, sales bigint, revenue numeric, match_kind text)
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
    SELECT e.origin, e.event, e.product_option AS code, host(e.ip) AS ip, e.dotid, e.event_at,
           e.metadata #>> '{upsell,g}' AS grp, e.metadata #>> '{upsell,fl}' AS flow, e.metadata #>> '{upsell,p}' AS page
    FROM f
    JOIN tracking.dot_events e
      ON e.event IN ('upsell_accept', 'downsell_accept')
     AND e.event_at >= p_since
     AND e.product_option IN (SELECT code FROM codes)
     AND (e.page_id = f.page_id::text
          OR e.page_id IN (SELECT up.id::text FROM pages.page_content up
                           WHERE up.scope = 'VENDOR' AND up.kind = 'UPSELL'
                             AND up.product_id IS NOT DISTINCT FROM f.product_id AND up.platform IS NOT DISTINCT FROM f.platform))
  ),
  -- The sales: one row per order item (n = its place in the order).
  sold AS MATERIALIZED (
    SELECT o.order_key, o.platform_order_id, o.ordered_at, i.n, i.item ->> 'offer_code' AS code,
           CASE WHEN pg_input_is_valid(o.customer_ip, 'inet') THEN host(o.customer_ip::inet) END AS ip,
           coalesce((i.item ->> 'line_total')::numeric, 0) AS amount
    FROM f
    JOIN core.orders o
      ON o.platform = lower(f.platform)
     AND o.ordered_at >= p_since - interval '6 hours'
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END)
      WITH ORDINALITY AS i(item, n)
    WHERE i.item ->> 'offer_code' IN (SELECT code FROM codes)
      AND coalesce(i.item ->> 'type', '') NOT IN ('front', 'OFFER')
  ),
  -- The buyer of each order, as dot knows them: the dotids of the vendor_purchase events with its order id.
  -- A dotid the vendor_purchase events of another order also carry (within a day) is not a buyer's: it is
  -- the one dot minted for the checkout's own server when it didn't pass the buyer's (15/10: one id on
  -- every sale).
  buyers AS MATERIALIZED (
    SELECT DISTINCT s.order_key, e.dotid
    FROM (SELECT DISTINCT order_key, platform_order_id, ordered_at FROM sold WHERE platform_order_id IS NOT NULL) s
    JOIN tracking.dot_events e
      ON e.event = 'vendor_purchase'
     AND e.event_at >= s.ordered_at - interval '1 hour'
     AND e.event_at < s.ordered_at + interval '2 days'
     AND e.order_id = s.platform_order_id
     AND e.dotid IS NOT NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM tracking.dot_events o
      WHERE o.event = 'vendor_purchase' AND o.dotid = e.dotid AND o.order_id IS DISTINCT FROM e.order_id
        AND o.event_at BETWEEN e.event_at - interval '1 day' AND e.event_at + interval '1 day')
  ),
  exact AS (
    SELECT s.order_key, s.n, s.code, s.amount, a.origin, a.event, a.grp, a.flow, a.page
    FROM sold s
    CROSS JOIN LATERAL (
      SELECT x.origin, x.event, x.grp, x.flow, x.page
      FROM answers x
      JOIN buyers b ON b.order_key = s.order_key AND b.dotid = x.dotid
      WHERE x.code = s.code
        AND x.event_at >= s.ordered_at - interval '10 minutes'
        AND x.event_at < s.ordered_at + interval '24 hours'
      ORDER BY x.event_at DESC
      LIMIT 1
    ) a
  ),
  ip6h AS (
    SELECT s.order_key, s.n, s.code, s.amount, a.origin, a.event, a.grp, a.flow, a.page
    FROM sold s
    CROSS JOIN LATERAL (
      SELECT x.origin, x.event, x.grp, x.flow, x.page
      FROM answers x
      WHERE x.ip = s.ip AND x.code = s.code AND x.event_at BETWEEN s.ordered_at AND s.ordered_at + interval '6 hours'
      ORDER BY x.event_at DESC
      LIMIT 1
    ) a
    WHERE s.ip IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM exact e WHERE e.order_key = s.order_key AND e.n = s.n)
  ),
  tied AS (
    SELECT t.*, 'exact' AS match_kind FROM exact t
    UNION ALL
    SELECT t.*, 'ip6h' FROM ip6h t
  )
  SELECT t.origin, t.event, t.code, t.grp, t.flow, t.page, count(DISTINCT t.order_key), sum(t.amount), t.match_kind
  FROM tied t
  GROUP BY t.origin, t.event, t.code, t.grp, t.flow, t.page, t.match_kind
$$;
COMMENT ON FUNCTION pages.upsell_funnel_revenue(uuid, timestamptz) IS
  'An upsell funnel''s sales since p_since: the platform''s order items (core.orders, not the front) whose offer code is one of the product''s checkout values, each tied once to the buyer''s accept on our pages — exact (the order''s vendor_purchase in dot ↔ an accept with the same dotid and code, within 24 h of the order) or, only without that, ip6h (an accept with the same code and IP within 6 h). Per origin, event, offer code, group, flow, page and match_kind: sales (orders) and revenue (the items'' line totals). Unmatched sales are left out.';

REVOKE ALL ON FUNCTION pages.upsell_funnel_revenue(uuid, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_revenue(uuid, timestamptz) TO service_role;
