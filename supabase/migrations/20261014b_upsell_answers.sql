-- ============================================================================
-- DayOne Pages — the buyers' answers on an upsell funnel, from dot (tracking.dot_events).
--
-- The vendor's tracker (dot.js on a vendor page's upsell step, server/src/track.php) sends
-- upsell_accept / upsell_decline (origin vendor_up1…) and downsell_accept / downsell_decline
-- (origin vendor_up1_ds1…), the offer code in product_option, the vendor page in page_id and
-- what the buyer was served in metadata.upsell ({ s, g, fl, p, ds }). dot keeps one event of a
-- kind per origin and click. Those event names are rare, so the event index finds them fast.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.upsell_funnel_answers(p_funnel uuid, p_since timestamptz)
RETURNS TABLE(origin text, event text, offer text, grp text, flow text, slug text, n bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT e.origin, e.event, e.product_option,
         e.metadata #>> '{upsell,g}', e.metadata #>> '{upsell,fl}', e.metadata #>> '{upsell,p}',
         count(*)
  FROM pages.upsell_funnels uf
  JOIN tracking.dot_events e
    ON e.event IN ('upsell_accept', 'upsell_decline', 'downsell_accept', 'downsell_decline')
   AND e.event_at >= p_since
   AND e.page_id = uf.page_id::text
  WHERE uf.id = p_funnel
  GROUP BY 1, 2, 3, 4, 5, 6
$$;
COMMENT ON FUNCTION pages.upsell_funnel_answers(uuid, timestamptz) IS
  'The accept/decline answers dot recorded on an upsell funnel''s steps since p_since (tracking.dot_events, events upsell_*/downsell_* of the vendor page), per origin, event, offer code and what was served (group, flow, page version).';

REVOKE ALL ON FUNCTION pages.upsell_funnel_answers(uuid, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_answers(uuid, timestamptz) TO service_role;
