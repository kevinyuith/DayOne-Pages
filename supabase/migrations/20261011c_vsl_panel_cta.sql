-- ============================================================================
-- The VSLs tab's one call (pages.funnel_vsl_panel) also says whether the funnel's CTAs are on
-- (pages.funnels.cta_enabled, 20261011a) and how many published CTAs with a share it has, so the
-- tab can show each VSL's CTA mode (VTurb | Server) and only offer "Server" when it can work.
-- The split (`vsl`) already carries each VSL's `cta`. Only keys added: dayone-main's readers ignore them.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.funnel_vsl_panel(p_main_funnel uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH f AS (
    SELECT t.id, t.vsl, t.vsl_updated_at, t.cta, t.cta_enabled,
           ARRAY(SELECT jsonb_object_keys(t.vsl)) AS ids,
           ARRAY(SELECT k FROM (SELECT pages.vsl_title_key(x.v ->> 'name') AS k FROM jsonb_each(t.vsl) AS x(id, v)) n WHERE k <> '') AS names
    FROM pages.funnels t
    WHERE t.main_funnel_id = p_main_funnel
  )
  SELECT jsonb_build_object(
    'id', f.id,
    'updated_at', f.vsl_updated_at,
    'vsl', f.vsl,
    -- The funnel's CTAs at the pitch (cta.php): on, and how many published CTAs with a share.
    'cta_enabled', f.cta_enabled,
    'ctas_live', (SELECT count(*) FROM pages.cta c
                  WHERE c.funnel_id = f.id AND c.status = 'PUBLISHED' AND f.cta ? c.id::text
                    AND coalesce((f.cta -> c.id::text ->> 'weight')::int, 0) > 0),
    'vsls', coalesce((
      SELECT jsonb_agg(jsonb_build_object('vsl_id', e.id, 'title', e.title, 'funnel_status', e.funnel_status::text, 'language', e.language,
                                          'pitch', e.pitch, 'copywriter', e.copywriter_name, 'editor', e.editor_name,
                                          'video_ids', e.video_id::text[], 'video_url', nullif(e.metadata ->> 'video_url', ''))
                       ORDER BY e.updated_at DESC NULLS LAST, e.id)
      FROM public.v_vsl_explorer e
      WHERE e.archived_at IS NULL
        AND (e.video_id::text[] && f.ids OR pages.vsl_title_key(e.title) = ANY (f.names))), '[]'::jsonb))
  FROM f
$function$;
