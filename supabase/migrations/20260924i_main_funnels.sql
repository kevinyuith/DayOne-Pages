-- ============================================================================
-- DayOne Pages — the Funnel screen lists the dayone-main funnels (F1, F2...)
--
-- The funnels themselves live in dayone-main (public.funnels: code F1..Fn,
-- name, platform, niche, region, status). DayOne Pages only READS them, through
-- pages.main_funnels(), so the dashboard stays on the `pages` schema. A page
-- (pages.pages, usually kind FUNNEL) belongs to one of them through the
-- existing pages.pages.funnel_id (FK to public.funnels, ON DELETE SET NULL).
-- Nothing here writes to public.
-- ============================================================================

COMMENT ON COLUMN pages.pages.funnel_id IS 'The dayone-main funnel (public.funnels, F1, F2...) this page belongs to. The Funnel screen groups pages by it.';

CREATE OR REPLACE FUNCTION pages.main_funnels()
RETURNS TABLE (id uuid, code text, name text, platform text, niche text, region text, status text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.id, f.funnel_id::text, f.name::text, f.platform::text, f.niche::text, f.region::text, f.status::text
  FROM public.funnels f
  ORDER BY nullif(regexp_replace(coalesce(f.funnel_id, ''), '\D', '', 'g'), '')::int NULLS LAST, f.funnel_id, f.created_at
$$;
COMMENT ON FUNCTION pages.main_funnels() IS 'Read-only list of the dayone-main funnels (public.funnels), ordered by code (F1, F2...).';

REVOKE ALL ON FUNCTION pages.main_funnels() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.main_funnels() TO service_role;

NOTIFY pgrst, 'reload schema';
