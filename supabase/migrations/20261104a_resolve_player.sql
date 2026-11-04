-- The funnel's player in the gate's data (04/11/2026): pages.resolve gives each funnel its `player`
-- (pages.funnels.player, saved by the dashboard's Player window — dayone-main src/lib/funnel-player/config.ts),
-- and the gate copies it to the funnel route (rules.php). server/src/player.php puts it in the served VSL step
-- as <script type="application/json" data-dop-player>, and dot.js draws the layer.
--
-- Generated from the LIVE definition (system.schema_ddl, md5 of the body 3a0fc4a99000493206fa2c0c183f09c6 on
-- 04/11): the only change is the `|| CASE ... 'player' ...` after the CTAs. Grants stay (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
 RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb, action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text, status_code smallint, preserve_query boolean, content text, placeholders jsonb, gate jsonb, vsl jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.resolve: invalid key' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
    SELECT m.route_id, m.domain_id, m.priority, m.match_type, m.path_pattern,
           m.conditions, m.action, m.page_id, m.slug, m.slug_id,
           m.content_type, m.content_hash, m.redirect_url, m.status_code,
           m.preserve_query,
           CASE WHEN p_with_content AND m.slug_id IS NOT NULL
                THEN (SELECT p.slugs -> m.slug ->> 'content' FROM pages.page_content p WHERE p.id = m.page_id) END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain)
             -- A vendor page's {{checkout.<key>}}: its product's links on its platform (20261013a).
             || coalesce(ck.checkout, '{}'::jsonb)
             -- A vendor page's {{product.name}} / {{product.kit<N>.<field>}}: its product's bundles (20261015d).
             || coalesce(pk.product, '{}'::jsonb) AS placeholders,
           jsonb_build_object(
             'status', CASE WHEN d.last_check_ok IS TRUE THEN d.status ELSE 'DISABLED' END,
             'gate_slugs', coalesce(d.gate_slugs, '[]'::jsonb),
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
             ), '{}'::jsonb),
             -- The vendor pages' upsell funnels, live, by page id, with the upsell pages their versions
             -- name (VENDOR + kind UPSELL, the vendor page's product and platform, not archived): each
             -- one's served slug ("/", else its first active one) and hash (server/src/upsell.php serves
             -- it at the step's path; 20261014a, 20261014d).
             'upsell', coalesce((
               SELECT jsonb_object_agg(uf.page_id::text, uf.live || jsonb_build_object(
                        'id', uf.id,
                        'pages', coalesce((
                          SELECT jsonb_object_agg(up.id::text, jsonb_build_object(
                                   'slug', sl.key,
                                   'hash', sl.value ->> 'content_hash',
                                   'type', coalesce(sl.value ->> 'content_type', 'text/html; charset=utf-8')))
                          FROM pages.page_content vp
                          JOIN pages.page_content up
                            ON up.id IN (SELECT pages.upsell_config_pages(uf.live))
                           AND up.scope = 'VENDOR' AND up.kind = 'UPSELL' AND up.status <> 'ARCHIVED'
                           AND up.product_id IS NOT DISTINCT FROM vp.product_id
                           AND up.platform IS NOT DISTINCT FROM vp.platform
                          CROSS JOIN LATERAL (
                            SELECT s.key, s.value FROM jsonb_each(up.slugs) s
                            WHERE coalesce((s.value ->> 'is_active')::boolean, false) AND s.value ->> 'content_hash' IS NOT NULL
                            ORDER BY s.key = '/' DESC, s.key LIMIT 1
                          ) sl
                          WHERE vp.id = uf.page_id
                        ), '{}'::jsonb)))
               FROM pages.upsell_funnels uf
               WHERE d.page ? uf.page_id::text
                 AND jsonb_array_length(coalesce(uf.live -> 'steps', '[]'::jsonb)) > 0
             ), '{}'::jsonb),
             -- The domain's default funnel in UNLOCKED (dayone-main's dashboard sets it when it unlocks the domain): a click without [F…].
             'default_funnel', nullif(upper(btrim(coalesce(d.settings ->> 'default_funnel', ''))), ''),
             -- The rules that block: active and not in Monitor.
             'rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', r.id, 'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active AND NOT r.is_monitor
             ), '[]'::jsonb),
             -- The device checkpoint's rules (server/src/eval.php): the active
             -- Suspicious ones. Present and non-empty = the checkpoint is on.
             'eval_rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', r.id, 'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active AND NOT r.is_monitor AND lower(r.label) = 'suspicious'
             ), '[]'::jsonb),
             -- Monitor mode: evaluated and recorded in the hit's rule_matches, never blocks (rules.php gate_rules_matched).
             'monitor_rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', r.id, 'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active AND r.is_monitor
             ), '[]'::jsonb),
             'funnels', coalesce((
               SELECT jsonb_object_agg(upper(f.code), jsonb_build_object(
                 -- The funnel's name: the UNLOCKED domain's funnel picker lists it next to the code.
                 'name', f.name,
                 'split', sp.split,
                 'vsl', (
                   SELECT jsonb_agg(jsonb_build_object('id', v.key, 'weight', (v.value ->> 'weight')::numeric)
                                    -- The VSL's CTA mode: the server's CTAs at the pitch (a funnel with CTAs on only).
                                    || CASE WHEN f.cta_enabled AND v.value ->> 'cta' = 'server'
                                            THEN '{"cta": true}'::jsonb ELSE '{}'::jsonb END)
                   FROM jsonb_each(f.vsl) v
                   WHERE coalesce((v.value ->> 'weight')::numeric, 0) > 0
                 )
               ) || coalesce((
                 -- The funnel's published CTAs with a share, drawn at the pitch by /_dop/cta (a funnel
                 -- with CTAs on only; absent otherwise).
                 SELECT jsonb_build_object('ctas', jsonb_agg(jsonb_build_object(
                          'id', c.id,
                          'weight', (f.cta -> c.id::text ->> 'weight')::int,
                          'content_hash', c.content_hash
                        ) ORDER BY c.created_at, c.id))
                 FROM pages.cta_content c
                 WHERE f.cta_enabled
                   AND c.funnel_id = f.id
                   AND f.cta ? c.id::text
                   AND c.status = 'PUBLISHED'
                   AND coalesce((f.cta -> c.id::text ->> 'weight')::int, 0) > 0
                 HAVING count(*) > 0
               ), '{}'::jsonb)
               -- The funnel's player (pages.funnels.player, the dashboard's Player of 04/11 — server/src/player.php):
               -- the layer the tracker draws over the VSL. Absent when nothing was saved.
               || CASE WHEN f.player IS NOT NULL AND f.player <> '{}'::jsonb
                       THEN jsonb_build_object('player', f.player) ELSE '{}'::jsonb END)
               FROM pages.funnels f
               CROSS JOIN LATERAL (
                 SELECT jsonb_agg(jsonb_build_object(
                          'page_id', p.id,
                          'content_type', coalesce(sl.s ->> 'content_type', 'text/html; charset=utf-8'),
                          'content_hash', sl.s ->> 'content_hash',
                          'weight', coalesce((f.page -> p.id::text ->> 'weight')::int, 0),
                          'redirect', CASE WHEN coalesce(sl.s ->> 'content_type', '') = 'text/x-redirect'
                                           THEN nullif(btrim(coalesce(sl.s ->> 'content', '')), '') END
                        ) ORDER BY p.created_at, p.id) AS split
                 -- The pages the funnel lists, each by its id, and its "/" slug read once: the slugs
                 -- carry the HTML, decompressed again by every ->> when inlined (20261020a).
                 FROM jsonb_object_keys(f.page) fk
                 JOIN pages.page_content p
                   ON p.id = CASE WHEN fk ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN fk::uuid END
                 CROSS JOIN LATERAL (SELECT p.slugs -> '/' AS s OFFSET 0) sl
                 WHERE p.scope = 'FUNNEL'
                   AND p.status = 'PUBLISHED'
                   AND coalesce((sl.s ->> 'is_active')::boolean, false)
                   AND coalesce((f.page -> p.id::text ->> 'weight')::int, 0) > 0
               ) sp
               WHERE sp.split IS NOT NULL AND f.code IS NOT NULL AND btrim(f.code) <> ''
             ), '{}'::jsonb)
           ) AS gate,
           vs.vsl
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id
    LEFT JOIN LATERAL (
      SELECT coalesce(rp.funnel_id, (
               SELECT fx.id FROM pages.funnels fx WHERE fx.page ? rp.id::text
               ORDER BY (fx.code IS NULL OR btrim(fx.code) = '') DESC, fx.created_at LIMIT 1)) AS funnel_id
      FROM pages.page_content rp
      WHERE m.slug_id IS NOT NULL AND rp.id = m.page_id
    ) fp ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', x.key, 'weight', (x.value ->> 'weight')::numeric) ORDER BY x.key) AS vsl
      FROM pages.funnels fu
      CROSS JOIN LATERAL jsonb_each(fu.vsl) x
      WHERE fp.funnel_id IS NOT NULL AND fu.id = fp.funnel_id AND coalesce((x.value ->> 'weight')::numeric, 0) > 0
    ) vs ON true
    LEFT JOIN LATERAL (
      -- pages.products.checkout_links of the vendor page's product, on the page's platform, as checkout.<key>.
      SELECT jsonb_object_agg('checkout.' || l.key, l.value) AS checkout
      FROM pages.page_content vp
      JOIN pages.products pr ON pr.id = vp.product_id
      CROSS JOIN LATERAL jsonb_each(pr.checkout_links -> vp.platform) l
      WHERE vp.id = m.page_id AND vp.scope = 'VENDOR'
    ) ck ON true
    LEFT JOIN LATERAL (
      -- pages.products.cta_placeholders of the vendor page's product, as product.name / product.kit<N>.<field>.
      SELECT pages.product_placeholder_values(pr.cta_placeholders) AS product
      FROM pages.page_content vp
      JOIN pages.products pr ON pr.id = vp.product_id
      WHERE vp.id = m.page_id AND vp.scope = 'VENDOR'
    ) pk ON true;
END
$function$;
