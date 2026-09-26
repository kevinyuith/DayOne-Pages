-- ============================================================================
-- DayOne Pages — a funnel entry that redirects (instead of a page)
--
-- A redirect is a normal funnel page (pages.pages, scope FUNNEL) whose only
-- slug "/" has content_type = 'text/x-redirect' and whose content is the
-- destination URL TEMPLATE, e.g. https://offer.com/?utm_campaign={sub1}. It
-- lives in the funnel's split like any page: its own weight, status
-- (DRAFT/PUBLISHED), stats and copy-to-domain — so it is created with
-- funnel_page_add and edited with funnel_page_save, no new writer.
--
-- The only change is on the read side: resolve() puts the URL template in the
-- split entry as `redirect`, so the delivery server (funnel.php) 302s to it,
-- filling each {name} from the visit's query (server/src/funnel.php). A page
-- entry has redirect = null. Backward compatible: an old server ignores it.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
 RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb, action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text, status_code smallint, preserve_query boolean, content text, placeholders jsonb, gate jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.resolve: invalid key' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
    SELECT m.route_id, m.domain_id, m.priority, m.match_type, m.path_pattern,
           m.conditions, m.action, m.page_id, m.slug, m.slug_id,
           m.content_type, m.content_hash, m.redirect_url, m.status_code,
           m.preserve_query,
           CASE WHEN p_with_content AND m.slug_id IS NOT NULL
                THEN (SELECT p.slugs -> m.slug ->> 'content' FROM pages.pages p WHERE p.id = m.page_id) END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders,
           jsonb_build_object(
             'status', d.status,
             'gate_slugs', coalesce(d.gate_slugs, '[]'::jsonb),
             'rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active
             ), '[]'::jsonb),
             'funnels', coalesce((
               SELECT jsonb_object_agg(upper(f.code), jsonb_build_object(
                 'split', sp.split,
                 'vsl', (
                   SELECT jsonb_agg(jsonb_build_object('id', v.key, 'weight', (v.value ->> 'weight')::numeric))
                   FROM jsonb_each(f.vsl) v
                   WHERE coalesce((v.value ->> 'weight')::numeric, 0) > 0
                 )
               ))
               FROM pages.funnels f
               CROSS JOIN LATERAL (
                 SELECT jsonb_agg(jsonb_build_object(
                          'page_id', p.id,
                          'content_type', coalesce(sl.s ->> 'content_type', 'text/html; charset=utf-8'),
                          'content_hash', sl.s ->> 'content_hash',
                          'weight', coalesce((f.site -> p.id::text ->> 'weight')::int, 0),
                          'redirect', CASE WHEN coalesce(sl.s ->> 'content_type', '') = 'text/x-redirect'
                                           THEN nullif(btrim(coalesce(sl.s ->> 'content', '')), '') END
                        ) ORDER BY p.created_at, p.id) AS split
                 FROM pages.pages p
                 CROSS JOIN LATERAL (SELECT p.slugs -> '/' AS s) sl
                 WHERE f.site ? p.id::text
                   AND p.scope = 'FUNNEL'
                   AND p.status = 'PUBLISHED'
                   AND coalesce((sl.s ->> 'is_active')::boolean, false)
                   AND coalesce((f.site -> p.id::text ->> 'weight')::int, 0) > 0
               ) sp
               WHERE sp.split IS NOT NULL AND f.code IS NOT NULL AND btrim(f.code) <> ''
             ), '{}'::jsonb)
           ) AS gate
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id;
END $function$;

NOTIFY pgrst, 'reload schema';
