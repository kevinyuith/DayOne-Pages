-- ============================================================================
-- DayOne Pages — Add VSL lists only the funnel's niche and language
--
-- Like dayone-main's A/B VSL picker (/api/funnels/ab-test-vsls): only
-- FINALIZED VSLs (not archived) of the funnel's niche (public.niches: the
-- funnel's code → the VSL's value, ED → ERECAO) and of its region's language
-- ("US/EN" → EN; the old GE is DE). A niche without a code (OT) lists nothing.
-- The words, when given, narrow the list. Read-only on dayone-main.
-- ============================================================================

DROP FUNCTION IF EXISTS pages.main_vsls_search(text[], integer);

CREATE FUNCTION pages.main_vsls_search(p_main_funnel uuid, p_words text[] DEFAULT '{}', p_limit integer DEFAULT 50)
RETURNS TABLE (vsl_id uuid, title text, funnel_status text, language text, pitch integer,
               copywriter text, editor text, video_ids text[], video_url text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH f AS (
    SELECT n.value AS niche,
           CASE upper(btrim(split_part(fu.region, '/', 2))) WHEN 'GE' THEN 'DE' ELSE upper(btrim(split_part(fu.region, '/', 2))) END AS language
    FROM public.funnels fu
    JOIN public.niches n ON upper(n.code) = upper(btrim(fu.niche))
    WHERE fu.id = p_main_funnel
  )
  SELECT e.id, e.title, e.funnel_status::text, e.language, e.pitch, e.copywriter_name, e.editor_name,
         e.video_id::text[], nullif(e.metadata ->> 'video_url', '')
  FROM f
  JOIN public.v_vsl_explorer e ON e.niche = f.niche AND upper(e.language) = f.language
  WHERE e.archived_at IS NULL
    AND e.status::text = 'FINALIZED'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(coalesce(p_words, '{}')) AS w(word)
      WHERE strpos(lower(concat_ws(' ', e.title, e.copywriter_name, e.editor_name, e.mechanism)), lower(w.word)) = 0)
  -- Status order = VSL_STATUSES in src/lib/pages/queries.ts; then the most recent.
  ORDER BY coalesce(array_position(ARRAY['VALIDATED', 'VALIDATION', 'STAND_BY', 'PAUSED', 'DISCARDED'], e.funnel_status::text), 6),
           e.completed_at DESC NULLS LAST, e.title
  LIMIT greatest(1, least(coalesce(p_limit, 50), 100))
$$;

COMMENT ON FUNCTION pages.main_vsls_search(uuid, text[], integer) IS 'Add VSL: the finished dayone-main VSLs of the funnel''s niche and language (optionally containing every word). Read-only.';

REVOKE ALL ON FUNCTION pages.main_vsls_search(uuid, text[], integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.main_vsls_search(uuid, text[], integer) TO service_role;

NOTIFY pgrst, 'reload schema';
