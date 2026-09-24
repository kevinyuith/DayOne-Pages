-- ============================================================================
-- DayOne Pages — the VTurb token, behind one pages function
--
-- The dashboard writes the funnels' VTurb A/B tests (pages.funnels.vsl) with
-- VTurb's control API, which takes the web app's JWT (12 h). For now the
-- token is READ from dayone-main (public.vturb_jwt_current(), renewed by its
-- own job); nothing of dayone-main is changed. When this scope moves out of
-- dayone-main, only this function changes (e.g. to a pages-owned secret).
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.vturb_token()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT public.vturb_jwt_current()
$$;

COMMENT ON FUNCTION pages.vturb_token() IS 'The VTurb control API token (read from dayone-main for now). Server-only: never send it to the browser.';

REVOKE ALL ON FUNCTION pages.vturb_token() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.vturb_token() TO service_role;

NOTIFY pgrst, 'reload schema';
