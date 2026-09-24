-- ============================================================================
-- DayOne Pages — the funnel's VSLs tab in one small call
--
-- The tab read the funnel row, then EVERY dayone-main VSL (pages.main_vsls(),
-- ~290 KB) and every funnel's linked VSLs (pages.main_funnel_vsls(), ~640 KB)
-- to show a few rows; the Add VSL search read every VSL on each search. Now
-- pages.funnel_vsl_panel() returns the funnel's replica with only the VSLs
-- that can match its videos, and pages.main_vsls_search() filters in the
-- database. Still read-only on dayone-main.
-- ============================================================================

DROP FUNCTION IF EXISTS pages.main_vsls();
DROP FUNCTION IF EXISTS pages.main_funnel_vsls();

-- A video name as a VSL title: without the ".mp4" of the uploaded file
-- (titleKey in src/lib/pages/queries.ts).
CREATE OR REPLACE FUNCTION pages.vsl_title_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT lower(btrim(regexp_replace(coalesce(p_name, ''), '\.mp4$', '', 'i')))
$$;

-- A funnel's VSLs tab (by dayone-main funnel id): its pages.funnels row, the
-- replica of its VTurb A/B test, the dayone-main VSLs (not archived) that
-- can match the test's videos (by a VTurb player id the VSL pipeline
-- recorded, or by title = video name without ".mp4") and, when the funnel has
-- no test, the VSLs linked to it (public.vsl.funnel_ids). NULL = no row.
CREATE OR REPLACE FUNCTION pages.funnel_vsl_panel(p_main_funnel uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH f AS (
    SELECT t.id, t.vturb_group_id, t.vsl, t.vsl_synced_at,
           ARRAY(SELECT jsonb_object_keys(t.vsl)) AS ids,
           ARRAY(SELECT k FROM (SELECT pages.vsl_title_key(x.v ->> 'name') AS k FROM jsonb_each(t.vsl) AS x(id, v)) n WHERE k <> '') AS names
    FROM pages.funnels t
    WHERE t.main_funnel_id = p_main_funnel
  ),
  e AS (
    SELECT e.id, e.title, e.funnel_status::text AS funnel_status, e.language, e.pitch,
           e.copywriter_name AS copywriter, e.editor_name AS editor, e.video_id::text[] AS video_ids,
           nullif(e.metadata ->> 'video_url', '') AS video_url, e.funnel_ids, e.updated_at
    FROM public.v_vsl_explorer e
    WHERE e.archived_at IS NULL
  )
  SELECT jsonb_build_object(
    'id', f.id,
    'group_id', f.vturb_group_id,
    'synced_at', f.vsl_synced_at,
    'vsl', f.vsl,
    'vsls', coalesce((
      SELECT jsonb_agg(jsonb_build_object('vsl_id', e.id, 'title', e.title, 'funnel_status', e.funnel_status, 'language', e.language,
                                          'pitch', e.pitch, 'copywriter', e.copywriter, 'editor', e.editor,
                                          'video_ids', e.video_ids, 'video_url', e.video_url)
                       ORDER BY e.updated_at DESC NULLS LAST, e.id)
      FROM e
      WHERE e.video_ids && f.ids OR pages.vsl_title_key(e.title) = ANY (f.names)), '[]'::jsonb),
    'linked', CASE WHEN f.vturb_group_id IS NULL THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('vsl_id', e.id, 'title', e.title, 'funnel_status', e.funnel_status, 'language', e.language,
                                          'pitch', e.pitch, 'copywriter', e.copywriter, 'editor', e.editor, 'video_url', e.video_url))
      FROM e
      WHERE p_main_funnel = ANY (e.funnel_ids)), '[]'::jsonb) ELSE '[]'::jsonb END)
  FROM f
$$;

-- The produced VSLs (dayone-main, not archived) whose title, copywriter,
-- editor or language contain every word, in status order (VSL_STATUSES in
-- src/lib/pages/queries.ts) then title, at most p_limit (1–100).
CREATE OR REPLACE FUNCTION pages.main_vsls_search(p_words text[], p_limit integer DEFAULT 25)
RETURNS TABLE (vsl_id uuid, title text, funnel_status text, language text, pitch integer,
               copywriter text, editor text, video_ids text[], video_url text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT e.id, e.title, e.funnel_status::text, e.language, e.pitch, e.copywriter_name, e.editor_name,
         e.video_id::text[], nullif(e.metadata ->> 'video_url', '')
  FROM public.v_vsl_explorer e
  WHERE e.archived_at IS NULL
    AND cardinality(p_words) > 0
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p_words) AS w(word)
      WHERE strpos(lower(concat_ws(' ', e.title, e.copywriter_name, e.editor_name, e.language)), lower(w.word)) = 0)
  ORDER BY coalesce(array_position(ARRAY['VALIDATED', 'VALIDATION', 'STAND_BY', 'PAUSED', 'DISCARDED'], e.funnel_status::text), 6), e.title
  LIMIT greatest(1, least(coalesce(p_limit, 25), 100))
$$;

COMMENT ON FUNCTION pages.funnel_vsl_panel(uuid) IS 'A funnel''s VSLs tab: its VTurb A/B test replica, the dayone-main VSLs matching its videos and, without a test, the VSLs linked to it. Read-only on dayone-main.';
COMMENT ON FUNCTION pages.main_vsls_search(text[], integer) IS 'The produced dayone-main VSLs (not archived) containing every word, for Add VSL. Read-only.';

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.vsl_title_key(text)',
    'pages.funnel_vsl_panel(uuid)',
    'pages.main_vsls_search(text[], integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
