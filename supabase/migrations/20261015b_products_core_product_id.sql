-- ============================================================================
-- DayOne Pages — a product's id in core (the producer dashboard's own product), for dot.
--
-- The vendor's tracker (dot.js on a vendor page's landing and its upsell steps, server/src/track.php)
-- sends the product in every event (&product_id= on its URL → product_id and _metadata.product_id),
-- so the producer dashboard can read its funnel's events by its own product. That product lives in
-- the core schema (core.products, tipo 'produto'); its external id is the uuid the dashboard's
-- docs/sql/329 gives every product (dados.uuid, born once, never changes), and the dashboard's
-- core.products_pages_link_save / _delete stamp it here through this function. The column is text
-- (a lowercase uuid; the check also admits a plain slug). No foreign key: core.products is the
-- producer dashboard's table, not this schema's.
--
-- pages.product_core_id_set(p_product, p_core) writes it (NULL clears it) and returns the vendor
-- domains that serve the product's pages, for the caller to purge (pages.purge_request) — without a
-- purge the change takes effect within 30 s. pages.resolve passes it to the delivery server in its
-- gate (`vendor`, 20261015c).
-- ============================================================================

DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.products IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock pages.products in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

ALTER TABLE pages.products ADD COLUMN core_product_id text;
ALTER TABLE pages.products ADD CONSTRAINT ck_products_core_product_id
  CHECK (core_product_id IS NULL OR core_product_id ~ '^[a-z0-9][a-z0-9_-]{0,99}$');
COMMENT ON COLUMN pages.products.core_product_id IS
  'The product''s id in core (the uuid in core.products dados.uuid of tipo produto, docs/sql/329; no foreign key): the vendor''s tracker sends it to dot as product_id on the vendor pages of this product (pages.resolve gate.vendor). NULL = not linked: the tracker sends none. Written by pages.product_core_id_set, called by the dashboard''s core.products_pages_link_save/_delete.';

-- The compatibility view takes the new column (CREATE OR REPLACE VIEW appends it, as in 20261013a).
CREATE OR REPLACE VIEW public.products WITH (security_invoker = true) AS SELECT * FROM pages.products;

CREATE FUNCTION pages.product_core_id_set(p_product uuid, p_core text)
RETURNS TABLE(domain text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_core text := nullif(btrim(coalesce(p_core, '')), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pages.products p WHERE p.id = p_product) THEN
    RAISE EXCEPTION 'product_core_id_set: product % not found', p_product USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE pages.products
  SET core_product_id = v_core, updated_at = clock_timestamp()
  WHERE id = p_product AND core_product_id IS DISTINCT FROM v_core;
  -- The vendor domains that serve one of its pages (their gate carries the id).
  RETURN QUERY
    SELECT DISTINCT d.domain
    FROM pages.domains d
    WHERE d.type = 'VENDOR'
      AND EXISTS (SELECT 1 FROM jsonb_object_keys(d.page) k
                  JOIN pages.page_content p ON p.id = k::uuid
                  WHERE p.scope = 'VENDOR' AND p.product_id = p_product)
    ORDER BY 1;
END $$;
COMMENT ON FUNCTION pages.product_core_id_set(uuid, text) IS
  'Links a product to its core product (the core uuid, core.products dados.uuid; NULL or empty clears it). Returns the VENDOR domains that serve the product''s pages, for the caller to purge (pages.purge_request).';

REVOKE ALL ON FUNCTION pages.product_core_id_set(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.product_core_id_set(uuid, text) TO service_role;
