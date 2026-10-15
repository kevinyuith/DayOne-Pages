-- ============================================================================
-- DayOne Pages — an upsell step's aliases, and the vendor page's folder (the owner, 15/10/2026:
-- keep the URLs already registered on the platforms — create aliases, don't move paths).
--
-- A step keeps its canonical path (/up1 … /up5, /thank-you: the routing is internal, 20261014d) and
-- is ALSO served at its aliases:
--   - implicitly at <the vendor page's folder> + <canonical path>: the platforms of a product live
--     side by side on a domain (the root, /cp/, /bg/), so a vendor page with no "/" slug whose slugs
--     all share their first segment lives in that folder (pages.vendor_page_folder: "/bg"), and its
--     funnel's Upsell 1 is also /bg/up1, its Thank you page /bg/thank-you;
--   - explicitly at the step's `aliases` in the config: lowercase paths (/bg/up1v2 → Upsell 1), at
--     most 10 per step, each in one place of the funnel, never a step's canonical path nor ending
--     with another step's (pages.upsell_config_check; upsellConfigSchema and vendor-paths.ts in the
--     dashboard check the same).
-- The delivery server (server/src/upsell.php) matches a request against the canonical path and the
-- aliases; when two vendor pages of a domain claim the same path, the one whose folder holds it
-- wins. The gate lets an alias reach the funnel like its step (rules.php).
--
-- pages.resolve's gate gains `vendor`: the domain's vendor site pages by id, each with its folder
-- (its landing is the folder's root — the tracker's vendor_front, and the implicit aliases above)
-- and its product's core id (pages.products.core_product_id, 20261015b: the tracker's &product_id=).
-- Patched in place (resolve carries dayone-main's default_funnel; it is never rewritten from a file).
-- ============================================================================

CREATE FUNCTION pages.vendor_page_folder(p_slugs jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN coalesce(jsonb_typeof(p_slugs), '') <> 'object' OR p_slugs ? '/' THEN ''
           WHEN count(DISTINCT split_part(k, '/', 2)) = 1 AND min(split_part(k, '/', 2)) <> '' THEN '/' || min(split_part(k, '/', 2))
           ELSE ''
         END
  FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_slugs) = 'object' THEN p_slugs ELSE '{}'::jsonb END) k
$$;
COMMENT ON FUNCTION pages.vendor_page_folder(jsonb) IS
  'The folder a vendor page lives in, from its slugs: "/<segment>" when it has no "/" slug and every slug shares that first segment (/bg, /bg/up1 → "/bg"), else "" (the root). Its landing is the folder''s root; its upsell steps are also served at <folder> + <step path>. The same rule as vendorFolder (src/lib/pages/vendor-paths.ts).';

-- ── The config's shape: the 20261014d check plus each step's aliases ─────────

CREATE OR REPLACE FUNCTION pages.upsell_config_check(p jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  f  jsonb;
  st jsonb;
  g  jsonb;
  k  record;
  v  jsonb;
  a  jsonb;
  slot jsonb;
  v_flows text[] := '{}';
  v_steps text[] := '{}';
  v_groups text[];
  v_aliases text[] := '{}';
  v_canon text;
  v_key  constant text := '^[a-z][a-z0-9_]{0,39}$';
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_paths constant text[] := ARRAY['/up1', '/up2', '/up3', '/up4', '/up5', '/thank-you'];
BEGIN
  IF coalesce(jsonb_typeof(p), '') <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('front_param', 'flows', 'steps')) THEN
    RAISE EXCEPTION 'upsell: the config must be { front_param, flows, steps }' USING ERRCODE = 'check_violation';
  END IF;
  IF p ? 'front_param' AND (jsonb_typeof(p -> 'front_param') <> 'string' OR p ->> 'front_param' !~ '^[A-Za-z0-9_.-]{1,40}$') THEN
    RAISE EXCEPTION 'upsell: invalid front parameter' USING ERRCODE = 'check_violation';
  END IF;

  IF coalesce(jsonb_typeof(p -> 'flows'), 'array') <> 'array' OR jsonb_array_length(coalesce(p -> 'flows', '[]')) > 10 THEN
    RAISE EXCEPTION 'upsell: flows must be a list of at most 10' USING ERRCODE = 'check_violation';
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(coalesce(p -> 'flows', '[]')) LOOP
    IF jsonb_typeof(f) <> 'object' OR coalesce(f ->> 'id', '') !~ '^f[a-z0-9]{1,12}$' OR f ->> 'id' = ANY (v_flows)
       OR length(btrim(coalesce(f ->> 'name', ''))) NOT BETWEEN 1 AND 60
       OR coalesce(jsonb_typeof(f -> 'when'), '') <> 'object' THEN
      RAISE EXCEPTION 'upsell: invalid flow %', coalesce(f ->> 'id', '?') USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(f -> 'when') x
               WHERE x NOT IN ('countries', 'countries_mode', 'devices', 'languages', 'languages_mode', 'query', 'referrer', 'referrer_absent', 'cookies')) THEN
      RAISE EXCEPTION 'upsell: unknown condition in flow %', f ->> 'id' USING ERRCODE = 'check_violation';
    END IF;
    v_flows := v_flows || (f ->> 'id');
  END LOOP;

  IF coalesce(jsonb_typeof(p -> 'steps'), 'array') <> 'array' OR jsonb_array_length(coalesce(p -> 'steps', '[]')) > 6 THEN
    RAISE EXCEPTION 'upsell: steps must be a list of at most 6' USING ERRCODE = 'check_violation';
  END IF;
  FOR st IN SELECT value FROM jsonb_array_elements(coalesce(p -> 'steps', '[]')) LOOP
    IF jsonb_typeof(st) <> 'object' OR coalesce(st ->> 'id', '') NOT IN ('up1', 'up2', 'up3', 'up4', 'up5', 'ty')
       OR st ->> 'id' = ANY (v_steps)
       -- A step's path is fixed (/up1 … /up5, /thank-you): which page it serves is decided inside (20261014d).
       OR st ->> 'slug' IS DISTINCT FROM (CASE st ->> 'id' WHEN 'ty' THEN '/thank-you' ELSE '/' || (st ->> 'id') END) THEN
      RAISE EXCEPTION 'upsell: invalid step %', coalesce(st ->> 'id', '?') USING ERRCODE = 'check_violation';
    END IF;
    v_steps := v_steps || (st ->> 'id');
    v_canon := st ->> 'slug';

    -- Its aliases (20261015c): other paths it is served at — lowercase, at most 10, each in one place
    -- of the funnel, never a step's canonical path nor ending with another step's.
    IF st ? 'aliases' THEN
      IF jsonb_typeof(st -> 'aliases') <> 'array' OR jsonb_array_length(st -> 'aliases') > 10 THEN
        RAISE EXCEPTION 'upsell: at most 10 aliases (step %)', st ->> 'id' USING ERRCODE = 'check_violation';
      END IF;
      FOR a IN SELECT value FROM jsonb_array_elements(st -> 'aliases') LOOP
        IF jsonb_typeof(a) <> 'string' OR (a #>> '{}') !~ '^(/[a-z0-9._~-]+)+$' OR length(a #>> '{}') > 200
           OR (a #>> '{}') = v_canon
           OR EXISTS (SELECT 1 FROM unnest(v_paths) c WHERE c <> v_canon AND right(a #>> '{}', length(c)) = c)
           OR (a #>> '{}') = ANY (v_aliases) THEN
          RAISE EXCEPTION 'upsell: invalid alias % (step %)', left(a #>> '{}', 200), st ->> 'id' USING ERRCODE = 'check_violation';
        END IF;
        v_aliases := v_aliases || (a #>> '{}');
      END LOOP;
    END IF;

    IF st ->> 'id' = 'ty' THEN
      CONTINUE;
    END IF;
    IF coalesce(jsonb_typeof(st -> 'groups'), '') <> 'array' OR jsonb_array_length(st -> 'groups') NOT BETWEEN 1 AND 6 THEN
      RAISE EXCEPTION 'upsell: step % needs 1 to 6 groups', st ->> 'id' USING ERRCODE = 'check_violation';
    END IF;
    v_groups := '{}';
    FOR g IN SELECT value FROM jsonb_array_elements(st -> 'groups') LOOP
      IF jsonb_typeof(g) <> 'object' OR coalesce(g ->> 'id', '') !~ '^g[a-z0-9]{1,12}$' OR g ->> 'id' = ANY (v_groups)
         OR length(btrim(coalesce(g ->> 'name', ''))) NOT BETWEEN 1 AND 60
         OR coalesce(jsonb_typeof(g -> 'fronts'), '') <> 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(g -> 'fronts') x WHERE jsonb_typeof(x) <> 'string' OR x #>> '{}' !~ '^[A-Za-z0-9_.-]{1,40}$')
         OR coalesce(jsonb_typeof(g -> 'pages'), '') <> 'object' THEN
        RAISE EXCEPTION 'upsell: invalid group % in step %', coalesce(g ->> 'id', '?'), st ->> 'id' USING ERRCODE = 'check_violation';
      END IF;
      v_groups := v_groups || (g ->> 'id');
      FOR k IN SELECT key, value FROM jsonb_each(g -> 'pages') LOOP
        IF k.key <> 'default' AND NOT k.key = ANY (v_flows) OR jsonb_typeof(k.value) <> 'array' OR jsonb_array_length(k.value) > 10
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(k.value) x
                      WHERE jsonb_typeof(x) <> 'object' OR coalesce(x ->> 'page_id', '') !~ v_uuid
                         OR jsonb_typeof(x -> 'weight') <> 'number' OR (x ->> 'weight')::numeric NOT BETWEEN 0 AND 100) THEN
          RAISE EXCEPTION 'upsell: invalid pages for flow % (step %)', k.key, st ->> 'id' USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
      FOREACH v IN ARRAY ARRAY[coalesce(g -> 'vsls', '[]'), coalesce(g -> 'offers', '[]')] LOOP
        IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 10
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) x
                      WHERE jsonb_typeof(x) <> 'object' OR jsonb_typeof(x -> 'weight') <> 'number' OR (x ->> 'weight')::numeric NOT BETWEEN 0 AND 100
                         OR NOT (coalesce(x ->> 'id', '') ~ '^[A-Za-z0-9]{1,40}$' OR coalesce(x ->> 'offer', '') ~ v_key)) THEN
          RAISE EXCEPTION 'upsell: invalid VSLs or CTA in group % (step %)', g ->> 'id', st ->> 'id' USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
      IF coalesce(jsonb_typeof(g -> 'downsells'), 'array') <> 'array' OR jsonb_array_length(coalesce(g -> 'downsells', '[]')) > 3 THEN
        RAISE EXCEPTION 'upsell: at most 3 downsells (group %, step %)', g ->> 'id', st ->> 'id' USING ERRCODE = 'check_violation';
      END IF;
      FOR slot IN SELECT value FROM jsonb_array_elements(coalesce(g -> 'downsells', '[]')) LOOP
        IF jsonb_typeof(slot) <> 'array' OR jsonb_array_length(slot) NOT BETWEEN 1 AND 10
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(slot) x
                      WHERE jsonb_typeof(x) <> 'object' OR coalesce(x ->> 'offer', '') !~ v_key
                         OR jsonb_typeof(x -> 'weight') <> 'number' OR (x ->> 'weight')::numeric NOT BETWEEN 0 AND 100) THEN
          RAISE EXCEPTION 'upsell: invalid downsell (group %, step %)', g ->> 'id', st ->> 'id' USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- ── Delivery: the domain's vendor pages (folder, core product) in resolve's gate ──

DO $do$
DECLARE
  def  text := pg_get_functiondef('pages.resolve(text, text, text, boolean)'::regprocedure);
  next text;
BEGIN
  IF position($chk$'vendor', coalesce($chk$ IN def) > 0 THEN
    RAISE EXCEPTION 'pages.resolve: the gate already has vendor';
  END IF;
  next := replace(def,
    $old$'gate_slugs', coalesce(d.gate_slugs, '[]'::jsonb),$old$,
    $new$'gate_slugs', coalesce(d.gate_slugs, '[]'::jsonb),
             -- The domain's vendor site pages (scope VENDOR, not an upsell page), by id: each one's folder
             -- (pages.vendor_page_folder — its landing is the folder's root, and its upsell steps are also
             -- served at <folder> + <step path>; server/src/upsell.php) and its product's core id (the
             -- tracker's &product_id=, NULL = none; 20261015c).
             'vendor', coalesce((
               SELECT jsonb_object_agg(vp.id::text, jsonb_build_object(
                        'folder', pages.vendor_page_folder(vp.slugs),
                        'product', pr.core_product_id))
               FROM jsonb_object_keys(d.page) dk
               JOIN pages.page_content vp ON vp.id = dk::uuid AND vp.scope = 'VENDOR' AND vp.kind <> 'UPSELL'
               LEFT JOIN pages.products pr ON pr.id = vp.product_id
             ), '{}'::jsonb),$new$);
  IF next = def THEN
    RAISE EXCEPTION 'pages.resolve: the gate_slugs entry was not found';
  END IF;
  EXECUTE next;
END $do$;

REVOKE ALL ON FUNCTION pages.vendor_page_folder(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.vendor_page_folder(jsonb) TO service_role;
