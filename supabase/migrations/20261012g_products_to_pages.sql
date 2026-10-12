-- ============================================================================
-- The product registry moves to the pages schema (the owner, 12/10/2026: "traga os produtos para
-- dentro do schema pages — lá que iremos organizar os bundles e tudo mais com imagem"):
-- public.products → pages.products, the same table (rows, keys, indexes, the foreign keys of
-- public.vsl, pages.page_content and public.product_offer_content follow it; the views
-- v_vsl_explorer / v_vsl_tasks follow it too).
--
-- public.products stays as a COMPATIBILITY view over it (a simple view: it takes INSERT/UPDATE/
-- DELETE), so dayone-main's screens, routes and the VTurb worker keep reading and writing
-- `products` as before; the two functions that named public.products now name pages.products.
-- Next (pages): the bundles, their images per jar style and the checkouts as their own tables, and
-- the CTA's offer of a VSL built from its product + the checkout the VSL chose.
-- ============================================================================

DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE public.products IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock public.products in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

ALTER TABLE public.products SET SCHEMA pages;

COMMENT ON TABLE pages.products IS
  'The product registry (moved from public.products on 12/10/2026; public.products is its compatibility view): name, producer, code (in the VSL title), niche, format/currency/language, the CTA (design_html, cta_style, options, offer_visual) and the checkout links (checkouts, bundles, checkout_task_id). A VSL (public.vsl.product_id) chooses one of its checkouts (vsl.metadata.checkout_id) and its bottle combo (vsl.metadata.cta_combo).';

CREATE VIEW public.products WITH (security_invoker = true) AS SELECT * FROM pages.products;
COMMENT ON VIEW public.products IS
  'Compatibility (12/10/2026): the product registry lives in pages.products. dayone-main reads and writes through this view until it uses the new name.';
REVOKE ALL ON public.products FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO service_role;

-- The functions that named the old place.
DO $rw$
DECLARE
  r   record;
  def text;
BEGIN
  FOR r IN
    SELECT p.oid, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ 'public\.products\M'
  LOOP
    def := regexp_replace(r.def, 'public\.products\M', 'pages.products', 'g');
    EXECUTE def;
  END LOOP;
END $rw$;

NOTIFY pgrst, 'reload schema';
