-- ============================================================================
-- DayOne Pages — the VSLs of each dayone-main funnel (Funnel screen, VSLs tab)
--
-- Read-only, like pages.main_funnels(): the dashboard never reads or writes
-- `public` directly. A VSL belongs to the funnels in its public.vsl.funnel_ids
-- (the link the team sets in the VSL pipeline); archived VSLs are left out.
-- One row per (funnel, VSL); the names come from public.v_vsl_explorer.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.main_funnel_vsls()
RETURNS TABLE (funnel_id uuid, vsl_id uuid, title text, funnel_status text, language text, pitch integer,
               copywriter text, editor text, video_url text, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.fid, e.id, e.title, e.funnel_status, e.language, e.pitch,
         e.copywriter_name, e.editor_name, nullif(e.metadata ->> 'video_url', ''), e.updated_at
  FROM public.v_vsl_explorer e
  CROSS JOIN LATERAL unnest(e.funnel_ids) AS f(fid)
  WHERE e.archived_at IS NULL
$$;

COMMENT ON FUNCTION pages.main_funnel_vsls() IS 'The VSLs of each dayone-main funnel (public.vsl.funnel_ids, not archived), read-only for the Funnel screen.';

REVOKE ALL ON FUNCTION pages.main_funnel_vsls() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.main_funnel_vsls() TO service_role;

NOTIFY pgrst, 'reload schema';
