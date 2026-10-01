-- ============================================================================
-- DayOne Pages — the device checkpoint: the Suspicious stage runs in the browser
--
-- The gate decides with the request's data alone; what only a browser knows
-- (a real touchscreen, the pointer kind, WebGL, automation hooks) arrives too
-- late, with the beacon's signals. The checkpoint (server/src/eval.php) closes
-- the gap: a clean click on its way to the funnel first gets a minimal page
-- whose script collects the device's signals and POSTs them to /_dop/eval;
-- the SUSPICIOUS rules are evaluated there — the server decides what it can
-- (sub ids, URL parameters, the checkpoint cookie, signals stored from a
-- previous checkpoint), the browser answers the rest — and the reload carries
-- the matched rules (?dop_rules=), which the gate replays as the SAME
-- detection a server-side match would log. A passed checkpoint marks the
-- visitor with the dop_ev cookie (1 h).
--
-- The checkpoint is ON while at least one Suspicious rule is active: the
-- resolve's gate then carries them as `eval_rules` (same shape as `rules`,
-- active only). Bot rules still run first, in the gate's walk — the browser
-- stage only ever flags what the request stage didn't catch, and a rule can
-- also name `eval_cookie: "absent"` to catch, in the walk itself, a click
-- that never passed the checkpoint.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

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
                THEN (SELECT p.slugs -> m.slug ->> 'content' FROM pages.pages p WHERE p.id = m.page_id) END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders,
           jsonb_build_object(
             'status', CASE WHEN d.last_check_ok IS TRUE THEN d.status ELSE 'DISABLED' END,
             'gate_slugs', coalesce(d.gate_slugs, '[]'::jsonb),
             'rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active
             ), '[]'::jsonb),
             -- The device checkpoint's rules (server/src/eval.php): the active
             -- Suspicious ones. Present and non-empty = the checkpoint is on.
             'eval_rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active AND lower(r.label) = 'suspicious'
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
           ) AS gate,
           vs.vsl
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id
    LEFT JOIN LATERAL (
      SELECT coalesce(rp.funnel_id, (
               SELECT fx.id FROM pages.funnels fx WHERE fx.site ? rp.id::text
               ORDER BY (fx.code IS NULL OR btrim(fx.code) = '') DESC, fx.created_at LIMIT 1)) AS funnel_id
      FROM pages.pages rp
      WHERE m.slug_id IS NOT NULL AND rp.id = m.page_id
    ) fp ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', x.key, 'weight', (x.value ->> 'weight')::numeric) ORDER BY x.key) AS vsl
      FROM pages.funnels fu
      CROSS JOIN LATERAL jsonb_each(fu.vsl) x
      WHERE fp.funnel_id IS NOT NULL AND fu.id = fp.funnel_id AND coalesce((x.value ->> 'weight')::numeric, 0) > 0
    ) vs ON true;
END
$function$;
