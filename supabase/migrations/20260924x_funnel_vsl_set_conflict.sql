-- ============================================================================
-- DayOne Pages — funnel_vsl_set reports a conflict as NULL, not as 40001
--
-- PostgREST retries a transaction that fails with serialization_failure
-- (40001) by itself, again and again: raising it on a stale version made the
-- save hang instead of failing. Like page_save (zero rows back = conflict),
-- funnel_vsl_set now returns NULL when the split changed since it was loaded.
-- ============================================================================

-- Saves the funnel's split if its version is still p_expected (the
-- vsl_updated_at the screen loaded; NULL = never saved). Returns the new
-- version, or NULL when someone saved in between (nothing written).
CREATE OR REPLACE FUNCTION pages.funnel_vsl_set(p_funnel uuid, p_vsl jsonb, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  UPDATE pages.funnels f
  SET vsl = coalesce(p_vsl, '{}'::jsonb), vsl_updated_at = clock_timestamp()
  WHERE f.id = p_funnel AND f.vsl_updated_at IS NOT DISTINCT FROM p_expected
  RETURNING f.vsl_updated_at INTO v_at;
  IF FOUND THEN
    RETURN v_at;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pages.funnels f WHERE f.id = p_funnel) THEN
    RAISE EXCEPTION 'funnel_vsl_set: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
