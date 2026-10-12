-- ============================================================================
-- The values of a CTA's placements live on the product (the owner, 12/10/2026: "nessa tabela de
-- produtos, fique as informações que poderão ser trocadas no placeholder lá no CTA").
--
-- pages.products.cta_placeholders = { product, kits: { "<N>": { bottles, supply, image, price,
-- total, full_total, save } } } — the {{cta.product}} / {{cta.kit<N>.<field>}} values as the CTA
-- shows them ("2 BOTTLES", "60 Day Supply", "$79"…). The checkout is NOT stored there: it comes
-- from the product's own links, the checkout the VSL chose (vsl.metadata.checkout_id →
-- products.checkouts[].links) or, without a choice, the product's primary links
-- (products.options[].link) — wrapped in checkout.directdayone.com and stamped with b=<bottles>,
-- the same as dayone-main's CTA builder (vturb/lib-cta.js: resolveCheckoutOptions,
-- applyTemplateVariables, comMarcadorDeQuantidade).
--
-- A VSL's offer (pages.vsl_offers_resolved, read by cta_draw_get / cta_preview_get / vsl_offer_get):
-- a manual pages.vsl_offers row → the product of the player's VSL (public.vsl.product_id, one
-- product, at most one checkout choice that resolves) → the offer imported from the player's VTurb
-- CTA (pages.vsl_offers, source 'vturb'), for the players without a product.
--
-- The values were filled once (12/10/2026) by running dayone-main's own builder over every
-- product's design_html, currency, language and links; against the 1,766 players whose VSL names
-- a product, bottles / supply / price / total / full_total / save came out 100% equal.
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

ALTER TABLE pages.products ADD COLUMN cta_placeholders jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN pages.products.cta_placeholders IS
  'The values of the CTA placements for this product: { product, kits: { "<bottles>": { bottles, supply, image, price, total, full_total, save } } }, as displayed. The checkout is not here: it comes from the checkout the VSL chose (checkouts[].links) or the primary links (options[].link). Read by pages.vsl_offers_resolved.';

CREATE OR REPLACE FUNCTION pages.products_cta_placeholders_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  ph jsonb := NEW.cta_placeholders;
  k  record;
  f  record;
BEGIN
  IF coalesce(jsonb_typeof(ph), '') <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(ph) x WHERE x NOT IN ('product', 'kits')) THEN
    RAISE EXCEPTION 'products: cta_placeholders must be { product, kits }' USING ERRCODE = 'check_violation';
  END IF;
  IF ph ? 'product' AND (jsonb_typeof(ph -> 'product') <> 'string' OR length(btrim(ph ->> 'product')) NOT BETWEEN 1 AND 80) THEN
    RAISE EXCEPTION 'products: the CTA product name must have 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF ph ? 'kits' THEN
    IF jsonb_typeof(ph -> 'kits') <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(ph -> 'kits')) > 8 THEN
      RAISE EXCEPTION 'products: the CTA kits must be an object with at most 8 kits' USING ERRCODE = 'check_violation';
    END IF;
    FOR k IN SELECT key, value FROM jsonb_each(ph -> 'kits') LOOP
      IF k.key !~ '^[1-9][0-9]?$' OR jsonb_typeof(k.value) <> 'object' THEN
        RAISE EXCEPTION 'products: invalid CTA kit %', k.key USING ERRCODE = 'check_violation';
      END IF;
      FOR f IN SELECT key, value FROM jsonb_each(k.value) LOOP
        IF f.key = 'checkout' OR NOT (f.key = ANY (pages.cta_kit_fields())) OR jsonb_typeof(f.value) <> 'string'
           OR length(f.value #>> '{}') > 1000
           OR (f.key = 'image' AND (f.value #>> '{}') !~ '^(https?://|/(?!/))') THEN
          RAISE EXCEPTION 'products: invalid field % of CTA kit % (the checkout comes from the product''s checkouts)', f.key, k.key
            USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_pages_products_cta_placeholders_check
  BEFORE INSERT OR UPDATE OF cta_placeholders ON pages.products
  FOR EACH ROW EXECUTE FUNCTION pages.products_cta_placeholders_check();

-- The compatibility view takes the new column (a view's * is fixed when it is created).
CREATE OR REPLACE VIEW public.products WITH (security_invoker = true) AS SELECT * FROM pages.products;

-- A kit's checkout link as the CTA builder writes it: the raw link (any checkout.directdayone.com /
-- /checkout2 wrapper taken off), stamped with b=<bottles> when the link doesn't already END in a
-- b= (a b= in the middle is that platform's own parameter), inside checkout.directdayone.com?u=.
-- p_stamp false = no stamp (an INFO product has no kits). NULL = no link.
CREATE OR REPLACE FUNCTION pages.cta_checkout_url(p_link text, p_bottles int, p_stamp boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  l    text := btrim(coalesce(p_link, ''));
  prev text;
  s    text;
BEGIN
  LOOP
    prev := l;
    l := regexp_replace(l, '^https://checkout\.directdayone\.com\?u=', '', 'i');
    l := regexp_replace(l, '^/checkout2\?u=', '', 'i');
    EXIT WHEN l = prev;
  END LOOP;
  l := btrim(l);
  IF l = '' THEN
    RETURN NULL;
  END IF;
  IF p_stamp AND p_bottles IS NOT NULL THEN
    s := regexp_replace(l, '[?&]b=[0-9]+$', '', 'i');
    IF s <> '' THEN
      l := s || CASE WHEN strpos(s, '?') > 0 THEN '&' ELSE '?' END || 'b=' || p_bottles;
    END IF;
  END IF;
  RETURN 'https://checkout.directdayone.com?u=' || l;
END $$;

-- Each player's offer { product, kits }: a manual row, else its VSL's product (+ the VSL's
-- checkout), else the offer imported from its VTurb CTA. Players with none are left out.
CREATE OR REPLACE FUNCTION pages.vsl_offers_resolved(p_players text[])
RETURNS TABLE(player_id text, product text, kits jsonb, source text, product_id uuid, updated_by text, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH pl AS (
    SELECT DISTINCT x AS player_id FROM unnest(coalesce(p_players, '{}'::text[])) x WHERE x ~ '^[0-9a-f]{24}$'
  ), link AS (
    SELECT pl.player_id,
           count(DISTINCT v.product_id) AS n_products,
           min(v.product_id::text)::uuid AS product_id,
           count(DISTINCT v.metadata ->> 'checkout_id') AS n_choices,
           min(v.metadata ->> 'checkout_id') AS checkout_id
    FROM pl
    JOIN public.vsl v ON pl.player_id = ANY (v.video_id) AND v.product_id IS NOT NULL
    GROUP BY pl.player_id
  ), prod AS (
    SELECT l.player_id, p.id AS product_id, p.cta_placeholders AS ph, p.cta_style, p.updated_at,
           CASE WHEN l.checkout_id IS NULL THEN
             (SELECT jsonb_object_agg(o ->> 'quantity', btrim(o ->> 'link'))
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.options) = 'array' THEN p.options ELSE '[]'::jsonb END) o
              WHERE btrim(coalesce(o ->> 'link', '')) <> '')
           ELSE
             (SELECT c -> 'links'
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.checkouts) = 'array' THEN p.checkouts ELSE '[]'::jsonb END) c
              WHERE c ->> 'checkout_task_id' = l.checkout_id AND jsonb_typeof(c -> 'links') = 'object'
              LIMIT 1)
           END AS links
    FROM link l
    JOIN pages.products p ON p.id = l.product_id
    WHERE l.n_products = 1 AND l.n_choices <= 1
      AND btrim(coalesce(p.cta_placeholders ->> 'product', '')) <> ''
      AND jsonb_typeof(p.cta_placeholders -> 'kits') = 'object'
      AND p.cta_placeholders -> 'kits' <> '{}'::jsonb
  ), built AS (
    SELECT pr.player_id, pr.product_id, pr.ph ->> 'product' AS product, pr.updated_at,
           (SELECT jsonb_object_agg(k.key, k.value || jsonb_strip_nulls(jsonb_build_object('checkout',
                     pages.cta_checkout_url(pr.links ->> k.key, k.key::int, pr.cta_style IS DISTINCT FROM 'INFO'))))
            FROM jsonb_each(pr.ph -> 'kits') k) AS kits
    FROM prod pr
    WHERE pr.links IS NOT NULL AND pr.links <> '{}'::jsonb
  )
  SELECT pl.player_id,
         CASE WHEN m.player_id IS NOT NULL THEN m.product WHEN b.player_id IS NOT NULL THEN b.product ELSE i.product END,
         CASE WHEN m.player_id IS NOT NULL THEN m.kits WHEN b.player_id IS NOT NULL THEN b.kits ELSE i.kits END,
         CASE WHEN m.player_id IS NOT NULL THEN 'manual' WHEN b.player_id IS NOT NULL THEN 'product' ELSE i.source END,
         CASE WHEN m.player_id IS NULL THEN b.product_id END,
         CASE WHEN m.player_id IS NOT NULL THEN m.updated_by WHEN b.player_id IS NOT NULL THEN NULL ELSE i.updated_by END,
         CASE WHEN m.player_id IS NOT NULL THEN m.updated_at WHEN b.player_id IS NOT NULL THEN b.updated_at ELSE i.updated_at END
  FROM pl
  LEFT JOIN pages.vsl_offers m ON m.player_id = pl.player_id AND m.source = 'manual'
  LEFT JOIN built b ON b.player_id = pl.player_id
  LEFT JOIN pages.vsl_offers i ON i.player_id = pl.player_id AND i.source IS DISTINCT FROM 'manual'
  WHERE m.player_id IS NOT NULL OR b.player_id IS NOT NULL OR i.player_id IS NOT NULL
$$;

-- dayone-main's CTA stage fills its thumbnails and previews with this — now the resolved offer.
CREATE OR REPLACE FUNCTION pages.vsl_offer_get(p_players text[])
RETURNS TABLE(player_id text, product text, kits jsonb, source text, updated_by text, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT r.player_id, r.product, r.kits, r.source, r.updated_by, r.updated_at
  FROM pages.vsl_offers_resolved(p_players) r
$$;

CREATE OR REPLACE FUNCTION pages.cta_draw_get(p_page uuid, p_video text, p_key text)
RETURNS TABLE(block text, ctas jsonb, offer jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  f       record;
  o       record;
  v_avail text[] := '{}';
  v_group jsonb;
  v_ctas  jsonb := '[]'::jsonb;
  v_block text := 'default';
  v_jars  jsonb;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.cta_draw_get: invalid key' USING ERRCODE = '28000';
  END IF;
  IF p_page IS NULL OR p_video IS NULL OR p_video !~ '^[0-9a-f]{24}$' THEN
    RETURN;
  END IF;
  SELECT x.id, x.vsl, x.cta, x.cta_groups INTO f FROM pages.funnels x WHERE x.page ? p_page::text AND x.cta_enabled;
  IF NOT FOUND OR f.vsl -> p_video ->> 'cta' IS DISTINCT FROM 'server' THEN
    RETURN;
  END IF;
  SELECT x.product, x.kits INTO o FROM pages.vsl_offers_resolved(ARRAY[p_video]) x;
  IF o.product IS NOT NULL THEN
    v_avail := pages.vsl_offer_placements(o.product, o.kits);
  END IF;
  SELECT g INTO v_group FROM jsonb_array_elements(f.cta_groups) g WHERE g -> 'vsls' ? p_video LIMIT 1;
  IF v_group IS NULL AND o.product IS NOT NULL THEN
    SELECT g INTO v_group FROM jsonb_array_elements(f.cta_groups) g
    WHERE upper(btrim(g ->> 'product')) = upper(btrim(o.product)) LIMIT 1;
  END IF;
  IF v_group IS NOT NULL THEN
    v_ctas := pages.cta_block_drawable(f.id, v_group -> 'cta', v_avail);
    IF v_ctas <> '[]'::jsonb THEN
      v_block := v_group ->> 'id';
    END IF;
  END IF;
  IF v_block = 'default' THEN
    v_ctas := pages.cta_block_drawable(f.id, f.cta, v_avail);
  END IF;
  IF o.product IS NOT NULL THEN
    SELECT jsonb_object_agg(j.style, j.photos) INTO v_jars
    FROM pages.cta_jar_photos j
    WHERE j.product = upper(btrim(o.product))
      AND j.style IN (SELECT e ->> 'jar_style' FROM jsonb_array_elements(v_ctas) e);
  END IF;
  RETURN QUERY SELECT v_block, v_ctas,
    CASE WHEN o.product IS NULL THEN NULL
         ELSE jsonb_build_object('product', o.product, 'kits', o.kits, 'jars', coalesce(v_jars, '{}'::jsonb)) END;
END $$;

CREATE OR REPLACE FUNCTION pages.cta_preview_get(p_cta uuid, p_page uuid, p_video text, p_key text)
RETURNS TABLE(cta_id uuid, content_hash text, html text, status text, jar_style text, offer jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  f         record;
  c         record;
  v_product text;
  v_kits    jsonb;
  v_jars    jsonb;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.cta_preview_get: invalid key' USING ERRCODE = '28000';
  END IF;
  SELECT x.id, x.vsl, x.cta INTO f FROM pages.funnels x WHERE x.page ? p_page::text;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT x.id, x.content_hash, x.html, x.status, x.jar_style INTO c
  FROM pages.cta_content x
  WHERE x.id = p_cta AND btrim(x.html) <> '' AND (x.funnel_id IS NULL OR (x.funnel_id = f.id AND f.cta ? x.id::text));
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_video ~ '^[0-9a-f]{24}$' AND f.vsl ? p_video THEN
    SELECT o.product, o.kits INTO v_product, v_kits FROM pages.vsl_offers_resolved(ARRAY[p_video]) o;
    IF v_product IS NOT NULL AND c.jar_style IS NOT NULL THEN
      SELECT jsonb_build_object(j.style, j.photos) INTO v_jars
      FROM pages.cta_jar_photos j WHERE j.product = upper(btrim(v_product)) AND j.style = c.jar_style;
    END IF;
  END IF;
  RETURN QUERY SELECT c.id, c.content_hash, c.html, c.status, c.jar_style,
    CASE WHEN v_product IS NULL THEN NULL
         ELSE jsonb_build_object('product', v_product, 'kits', v_kits, 'jars', coalesce(v_jars, '{}'::jsonb)) END;
END $$;

-- A product's CTA values, over the version the screen loaded (NULL back = not found or changed
-- meanwhile). The servers' CTA copies take it within CACHE_TTL.
CREATE OR REPLACE FUNCTION pages.product_cta_placeholders_set(p_product uuid, p_placeholders jsonb, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  UPDATE pages.products
  SET cta_placeholders = coalesce(p_placeholders, '{}'::jsonb), updated_at = clock_timestamp()
  WHERE id = p_product AND updated_at IS NOT DISTINCT FROM p_expected
  RETURNING updated_at INTO v_at;
  RETURN v_at;
END $$;

REVOKE ALL ON FUNCTION pages.products_cta_placeholders_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.cta_checkout_url(text, int, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.cta_checkout_url(text, int, boolean) TO service_role;
REVOKE ALL ON FUNCTION pages.vsl_offers_resolved(text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.vsl_offers_resolved(text[]) TO service_role;
REVOKE ALL ON FUNCTION pages.product_cta_placeholders_set(uuid, jsonb, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.product_cta_placeholders_set(uuid, jsonb, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
