-- ============================================================================
-- DayOne Pages — the compatibility view public.funnels is dropped (24/10/2026, the owner's call).
--
-- 20261006b made pages.funnels the funnel table and left public.funnels as a view over it, written
-- through INSTEAD OF triggers (public.funnels_view_write). dayone-main's app and functions read
-- pages.funnels directly (`.schema('pages').from('funnels')`); 7 days of API logs show one reader of
-- the view left: dayone-main's VTurb worker (vturb/pipeline-worker.js, list-folders.js and
-- run-vsl-pipeline.js ask /rest/v1/funnels without a profile, every 12 h).
-- APPLY ONLY AFTER the worker that reads pages.funnels (branch fix/vturb-worker-pages-funnels) is live:
-- it's deployed by `railway up` from dayone-main's vturb/, not by a push. Its new queries return the
-- same 99 rows as the view (compared 24/10).
-- Restore: the view, its triggers and grants are in 20261006b.
-- ============================================================================

DROP VIEW public.funnels;
DROP FUNCTION public.funnels_view_write();
