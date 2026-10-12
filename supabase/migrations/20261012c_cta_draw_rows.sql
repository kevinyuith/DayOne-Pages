-- ============================================================================
-- The delivery server's RPC helper (supabase_rpc) reads rows: pages.cta_draw_get and the 4-argument
-- pages.cta_preview_get (20261012a) return one row — or none: nothing to show — instead of a bare
-- jsonb. Nobody called them yet. The 3-argument cta_preview_get (servers on the old code) stays.
-- ============================================================================

DROP FUNCTION IF EXISTS pages.cta_draw_get(uuid, text, text);
CREATE FUNCTION pages.cta_draw_get(p_page uuid, p_video text, p_key text)
RETURNS TABLE(block text, ctas jsonb, offer jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
  SELECT x.id, x.vsl, x.cta, x.cta_groups INTO f FROM pages.funnels x WHERE x.site ? p_page::text AND x.cta_enabled;
  IF NOT FOUND OR f.vsl -> p_video ->> 'cta' IS DISTINCT FROM 'server' THEN
    RETURN;
  END IF;
  SELECT x.product, x.kits INTO o FROM pages.vsl_offers x WHERE x.player_id = p_video;
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

COMMENT ON FUNCTION pages.cta_draw_get(uuid, text, text) IS
  'What the server draws from when a VSL reaches the pitch (cta.php): the VSL''s block (its group — listed, else by its offer''s product — when that has something to show, otherwise "default"), the designs the VSL''s offer can fill [{ id, weight, content_hash, jar_style }] and the offer { product, kits, jars }. No row = the VSL isn''t on CTA mode "server" in a funnel with CTAs on. Delivery server only (server key).';

DROP FUNCTION IF EXISTS pages.cta_preview_get(uuid, uuid, text, text);
CREATE FUNCTION pages.cta_preview_get(p_cta uuid, p_page uuid, p_video text, p_key text)
RETURNS TABLE(cta_id uuid, content_hash text, html text, status text, jar_style text, offer jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
  SELECT x.id, x.vsl, x.cta INTO f FROM pages.funnels x WHERE x.site ? p_page::text;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT x.id, x.content_hash, x.html, x.status, x.jar_style INTO c
  FROM pages.cta x
  WHERE x.id = p_cta AND btrim(x.html) <> '' AND (x.funnel_id IS NULL OR (x.funnel_id = f.id AND f.cta ? x.id::text));
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_video ~ '^[0-9a-f]{24}$' AND f.vsl ? p_video THEN
    SELECT o.product, o.kits INTO v_product, v_kits FROM pages.vsl_offers o WHERE o.player_id = p_video;
    IF v_product IS NOT NULL AND c.jar_style IS NOT NULL THEN
      SELECT jsonb_build_object(j.style, j.photos) INTO v_jars
      FROM pages.cta_jar_photos j WHERE j.product = upper(btrim(v_product)) AND j.style = c.jar_style;
    END IF;
  END IF;
  RETURN QUERY SELECT c.id, c.content_hash, c.html, c.status, c.jar_style,
    CASE WHEN v_product IS NULL THEN NULL
         ELSE jsonb_build_object('product', v_product, 'kits', v_kits, 'jars', coalesce(v_jars, '{}'::jsonb)) END;
END $$;

COMMENT ON FUNCTION pages.cta_preview_get(uuid, uuid, text, text) IS
  'The test link of a CTA (?dop_cta=<id>) with the VSL''s offer: its HTML, draft or published (the page''s funnel''s or the library''s), and the offer of p_video when it is a VSL of that funnel. Delivery server only (server key).';

REVOKE ALL ON FUNCTION pages.cta_draw_get(uuid, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.cta_draw_get(uuid, text, text) TO anon, service_role;
REVOKE ALL ON FUNCTION pages.cta_preview_get(uuid, uuid, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.cta_preview_get(uuid, uuid, text, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
