-- ============================================================================
-- DayOne Pages — a vendor page's {{product.*}} placeholders: its product's bundles as the CTA shows
-- them (the owner, 15/10/2026: the same values the CTA placements use, now on the vendor pages).
--
-- pages.products.cta_placeholders = { product, kits: { "<bottles>": { bottles, supply, image, price,
-- total, full_total, save } } } (20261012h) becomes, on a vendor page and its upsell steps:
--   {{product.name}}          cta_placeholders.product
--   {{product.kit6.price}}    kits["6"].price — every kit (1–99) and field above
-- pages.resolve merges them into the route's placeholders next to {{checkout.<key>}} (20261013a),
-- for the routes of a VENDOR page — an upsell step is served on its vendor page's route, and its
-- upsell page has the same product — so the delivery server replaces them like {{company.*}} (no
-- server change; the ETag follows the values) and a key with no value stays as written. The editor
-- suggests and previews the same values (src/lib/pages/product-values.ts, the same rule).
-- Patched in place (resolve carries dayone-main's default_funnel; it is never rewritten from a file).
-- ============================================================================

CREATE FUNCTION pages.product_placeholder_values(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN jsonb_typeof(p -> 'product') = 'string' THEN jsonb_build_object('product.name', p -> 'product') ELSE '{}'::jsonb END
         || coalesce((
              SELECT jsonb_object_agg('product.kit' || k.key || '.' || fl.key, fl.value)
              FROM jsonb_each(CASE WHEN jsonb_typeof(p -> 'kits') = 'object' THEN p -> 'kits' ELSE '{}'::jsonb END) k
              CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(k.value) = 'object' THEN k.value ELSE '{}'::jsonb END) fl
              WHERE k.key ~ '^[1-9][0-9]?$'
                AND fl.key IN ('bottles', 'supply', 'image', 'price', 'total', 'full_total', 'save')
                AND jsonb_typeof(fl.value) = 'string'
            ), '{}'::jsonb)
$$;
COMMENT ON FUNCTION pages.product_placeholder_values(jsonb) IS
  'A product''s cta_placeholders as a vendor page''s placeholders: product.name and product.kit<N>.<field> (bottles, supply, image, price, total, full_total, save; text values only). The same rule as productValues (src/lib/pages/product-values.ts).';

DO $do$
DECLARE
  def  text := pg_get_functiondef('pages.resolve(text, text, text, boolean)'::regprocedure);
  next text;
BEGIN
  IF position('pk.product' IN def) > 0 THEN
    RAISE EXCEPTION 'pages.resolve: the product placeholders are already there';
  END IF;
  next := replace(def,
    $old$|| coalesce(ck.checkout, '{}'::jsonb) AS placeholders,$old$,
    $new$|| coalesce(ck.checkout, '{}'::jsonb)
             -- A vendor page's {{product.name}} / {{product.kit<N>.<field>}}: its product's bundles (20261015d).
             || coalesce(pk.product, '{}'::jsonb) AS placeholders,$new$);
  IF next = def THEN
    RAISE EXCEPTION 'pages.resolve: the checkout placeholders expression was not found';
  END IF;
  def := next;

  next := replace(def,
    $old$WHERE vp.id = m.page_id AND vp.scope = 'VENDOR'
    ) ck ON true;$old$,
    $new$WHERE vp.id = m.page_id AND vp.scope = 'VENDOR'
    ) ck ON true
    LEFT JOIN LATERAL (
      -- pages.products.cta_placeholders of the vendor page's product, as product.name / product.kit<N>.<field>.
      SELECT pages.product_placeholder_values(pr.cta_placeholders) AS product
      FROM pages.page_content vp
      JOIN pages.products pr ON pr.id = vp.product_id
      WHERE vp.id = m.page_id AND vp.scope = 'VENDOR'
    ) pk ON true;$new$);
  IF next = def THEN
    RAISE EXCEPTION 'pages.resolve: the checkout join was not found';
  END IF;
  EXECUTE next;
END $do$;

REVOKE ALL ON FUNCTION pages.product_placeholder_values(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.product_placeholder_values(jsonb) TO service_role;
