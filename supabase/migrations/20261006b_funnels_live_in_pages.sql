-- ============================================================================
-- APPLIED ONCE on 2026-10-06 ~20:53 UTC from dayone-main (its migration 20261006i_funnels_live_in_pages,
-- the same text as this file — the two repositories share the database; do not apply again). Kept here
-- because it changes the `pages` schema. On the owner's "pode aplicar agora". Stage 2 of
-- "pages.funnels is the one funnel table — to the point of deleting public.funnels".
--
-- What it does
--   public.funnels (dayone-main's funnel record: code, name, platform, niche, region,
--   status, CPI/CPA/CPC/CPP limits, responsible, platform_data and the old A/B fields)
--   moves INTO pages.funnels, which already had one mirror row per funnel
--   (main_funnel_id) plus its pages (site) and VSLs (vsl). public.funnels then becomes a
--   VIEW over pages.funnels with the same column names and types, written through
--   INSTEAD OF triggers — so the 64 call sites and 17 SQL functions that read or write
--   "funnels" keep working, and the table itself (renamed public.funnels_before_pages,
--   untouched) can be dropped on the owner's word.
--
-- What does NOT change
--   * ids: dayone-main keeps using the same uuid (pages.funnels.main_funnel_id).
--   * deleting a funnel in dayone-main still only detaches the DayOne Pages row
--     (main_funnel_id = NULL, as the FK's ON DELETE SET NULL did): its pages and VSL
--     split stay.
--   * a real funnel = a pages.funnels row with main_funnel_id; the 120 "WHITE · domain"
--     rows (no code, no main id) stay out of the view.
--
-- pages.funnel_for only looks the row up now. It used to create it on first use with
-- INSERT ... ON CONFLICT DO NOTHING, and a CHECK is evaluated BEFORE the conflict: with
-- funnels_main_record_check in place that insert would raise instead of doing nothing
-- (found right before applying; both dashboards call it on every open). The row is
-- born with the funnel (the view's INSTEAD OF INSERT). pages.funnels_sync is a no-op.
--
-- Dry run (scratch schemas, aborted on purpose) before applying: 76 rows, 0 type/order/
-- data differences, insert/update/delete through the view ok, bad status / duplicate
-- code / missing name rejected, the white rows untouched. After applying: the same
-- checks on the live view, plus select/update-returning/rpc through PostgREST with the
-- service key.
--
-- ROLLBACK (while public.funnels_before_pages exists)
--   bring the old table up to date from the view (INSERT ... SELECT * FROM public.funnels
--   ON CONFLICT (id) DO UPDATE ...; DELETE what the view no longer has), DROP VIEW
--   public.funnels, DROP FUNCTION public.funnels_view_write(), ALTER TABLE
--   public.funnels_before_pages RENAME TO funnels, re-add the two foreign keys
--   (pages.funnels.main_funnel_id → funnels(id) ON DELETE SET NULL;
--   funnel_landers.funnel_id → funnels(id) ON DELETE CASCADE), restore pages.funnels_sync
--   and pages.funnel_for from the dayone-pages migrations. The new columns can stay.
-- ============================================================================

-- The locks, without queueing: a pending ACCESS EXCLUSIVE request would stall every new
-- reader of pages.funnels (the gate's resolve, both dashboards) for the whole lock_timeout.
-- NOWAIT fails at once instead, and the loop tries again every half second for 30 s.
-- (Two earlier attempts with a plain lock_timeout of 5 s were cancelled by long VSL
-- Analytics queries holding pages.funnels — vsl_metrics / vsl_metrics_by_source.)
DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.funnels, public.funnels, public.funnel_landers IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN RAISE EXCEPTION 'funnels tables still in use after % tries — nothing changed', i; END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

INSERT INTO pages.funnels AS t (main_funnel_id, code, name)
SELECT f.id, f.funnel_id, f.name FROM public.funnels f
ON CONFLICT (main_funnel_id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name
WHERE t.code IS DISTINCT FROM EXCLUDED.code OR t.name IS DISTINCT FROM EXCLUDED.name;
ALTER TABLE pages.funnels
  ADD COLUMN platform text,
  ADD COLUMN niche text,
  ADD COLUMN region text,
  ADD COLUMN status text,
  ADD COLUMN platform_data jsonb,
  ADD COLUMN max_cpi numeric,
  ADD COLUMN max_cpa numeric,
  ADD COLUMN max_cpc numeric,
  ADD COLUMN max_cpp numeric,
  ADD COLUMN responsible_email text,
  ADD COLUMN main_video_id text,
  ADD COLUMN main_vsl_traffic_distribution jsonb,
  ADD COLUMN main_landers jsonb,
  ADD COLUMN main_pre_landers jsonb,
  ADD COLUMN main_pages_traffic_distribution jsonb;
COMMENT ON COLUMN pages.funnels.status IS 'The funnel''s operating status (CREATION … ARCHIVED). NULL on rows that are not funnels (a domain''s white page).';
COMMENT ON COLUMN pages.funnels.responsible_email IS 'The media buyer in charge (public.profiles.email).';
COMMENT ON COLUMN pages.funnels.main_video_id IS 'dayone-main''s old single-VSL field. Not served: the VSLs that get traffic are in `vsl`.';
COMMENT ON COLUMN pages.funnels.main_vsl_traffic_distribution IS 'dayone-main''s old VSL distribution (display only). Not served: see `vsl`.';
COMMENT ON COLUMN pages.funnels.main_pages_traffic_distribution IS 'dayone-main''s old page distribution. Not served: see `site`.';
COMMENT ON COLUMN pages.funnels.main_landers IS 'dayone-main''s old lander list. Not served: see `site`.';
COMMENT ON COLUMN pages.funnels.main_pre_landers IS 'dayone-main''s old pre-lander list. Not served: see `site`.';
ALTER TABLE pages.funnels DISABLE TRIGGER trg_pages_funnels_updated_at;
UPDATE pages.funnels pf SET
  code = f.funnel_id, name = f.name,
  platform = f.platform, niche = f.niche, region = f.region, status = f.status,
  platform_data = f.platform_data,
  max_cpi = f.max_cpi, max_cpa = f.max_cpa, max_cpc = f.max_cpc, max_cpp = f.max_cpp,
  responsible_email = f.responsible_email,
  main_video_id = f.video_id,
  main_vsl_traffic_distribution = f.vsl_traffic_distribution,
  main_landers = f.landers, main_pre_landers = f.pre_landers,
  main_pages_traffic_distribution = f.pages_traffic_distribution,
  created_at = coalesce(f.created_at, pf.created_at),
  updated_at = greatest(pf.updated_at, coalesce(f.updated_at, pf.updated_at))
FROM public.funnels f
WHERE pf.main_funnel_id = f.id;
ALTER TABLE pages.funnels ENABLE TRIGGER trg_pages_funnels_updated_at;
DO $$
DECLARE a int; b int;
BEGIN
  SELECT count(*) INTO a FROM public.funnels;
  SELECT count(*) INTO b FROM pages.funnels WHERE main_funnel_id IS NOT NULL;
  IF a <> b THEN
    RAISE EXCEPTION 'funnels do not line up: % in public.funnels, % pages.funnels rows with main_funnel_id', a, b;
  END IF;
END $$;
ALTER TABLE pages.funnels
  ADD CONSTRAINT funnels_main_record_check CHECK (
    main_funnel_id IS NULL OR (
      code IS NOT NULL AND name IS NOT NULL AND platform IS NOT NULL AND niche IS NOT NULL
      AND region IS NOT NULL AND status IS NOT NULL AND main_landers IS NOT NULL AND main_pre_landers IS NOT NULL
      AND char_length(code) <= 20 AND char_length(name) <= 255 AND char_length(platform) <= 100
      AND char_length(niche) <= 100 AND char_length(region) <= 20
    )),
  ADD CONSTRAINT funnels_status_check CHECK (
    status IS NULL OR status IN ('CREATION','SETUP','STAND_BY','VALIDATING','IN_PROGRESS','ACTIVE','SCALING','PAUSED','RECOVERING','SUSPENDED','ARCHIVED')),
  ADD CONSTRAINT funnels_responsible_email_check CHECK (
    responsible_email IS NULL OR responsible_email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  ADD CONSTRAINT funnels_responsible_email_fkey FOREIGN KEY (responsible_email)
    REFERENCES public.profiles(email) ON UPDATE CASCADE ON DELETE SET NULL;
CREATE UNIQUE INDEX funnels_main_code_key ON pages.funnels (code) WHERE main_funnel_id IS NOT NULL;
CREATE INDEX funnels_responsible_email_idx ON pages.funnels (responsible_email);
ALTER TABLE pages.funnels DROP CONSTRAINT funnels_main_funnel_id_fkey;
ALTER TABLE public.funnel_landers DROP CONSTRAINT funnel_landers_funnel_id_fkey;
ALTER TABLE public.funnels RENAME TO funnels_before_pages;
CREATE VIEW public.funnels AS
SELECT f.main_funnel_id                              AS id,
       f.code::character varying(20)                 AS funnel_id,
       f.name::character varying(255)                AS name,
       f.platform::character varying(100)            AS platform,
       f.niche::character varying(100)               AS niche,
       f.region::character varying(20)               AS region,
       f.status::character varying(20)               AS status,
       f.created_at, f.updated_at,
       f.platform_data, f.max_cpi, f.max_cpa, f.max_cpc, f.max_cpp,
       f.responsible_email,
       f.main_video_id                               AS video_id,
       f.main_vsl_traffic_distribution               AS vsl_traffic_distribution,
       f.main_landers                                AS landers,
       f.main_pre_landers                            AS pre_landers,
       f.main_pages_traffic_distribution             AS pages_traffic_distribution
FROM pages.funnels f
WHERE f.main_funnel_id IS NOT NULL;
COMMENT ON VIEW public.funnels IS 'Compatibility view (2026-10): the funnels live in pages.funnels. Same columns and types as the old table; writes go through funnels_view_write.';
ALTER VIEW public.funnels ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER VIEW public.funnels ALTER COLUMN platform SET DEFAULT '';
ALTER VIEW public.funnels ALTER COLUMN niche SET DEFAULT '';
ALTER VIEW public.funnels ALTER COLUMN region SET DEFAULT '';
ALTER VIEW public.funnels ALTER COLUMN status SET DEFAULT 'IN_PROGRESS';
ALTER VIEW public.funnels ALTER COLUMN created_at SET DEFAULT now();
ALTER VIEW public.funnels ALTER COLUMN updated_at SET DEFAULT now();
ALTER VIEW public.funnels ALTER COLUMN vsl_traffic_distribution SET DEFAULT '{}'::jsonb;
ALTER VIEW public.funnels ALTER COLUMN landers SET DEFAULT '[]'::jsonb;
ALTER VIEW public.funnels ALTER COLUMN pre_landers SET DEFAULT '[]'::jsonb;
CREATE FUNCTION public.funnels_view_write() RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.id IS NULL THEN NEW.id := gen_random_uuid(); END IF;
    INSERT INTO pages.funnels (
      main_funnel_id, code, name, platform, niche, region, status, created_at, updated_at,
      platform_data, max_cpi, max_cpa, max_cpc, max_cpp, responsible_email,
      main_video_id, main_vsl_traffic_distribution, main_landers, main_pre_landers, main_pages_traffic_distribution
    ) VALUES (
      NEW.id, NEW.funnel_id, NEW.name, NEW.platform, NEW.niche, NEW.region, NEW.status,
      coalesce(NEW.created_at, now()), coalesce(NEW.updated_at, now()),
      NEW.platform_data, NEW.max_cpi, NEW.max_cpa, NEW.max_cpc, NEW.max_cpp, NEW.responsible_email,
      NEW.video_id, NEW.vsl_traffic_distribution, NEW.landers, NEW.pre_landers, NEW.pages_traffic_distribution
    );
    SELECT v.* INTO NEW FROM public.funnels v WHERE v.id = NEW.id;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE pages.funnels f SET
      main_funnel_id = NEW.id, code = NEW.funnel_id, name = NEW.name,
      platform = NEW.platform, niche = NEW.niche, region = NEW.region, status = NEW.status,
      created_at = coalesce(NEW.created_at, f.created_at),
      platform_data = NEW.platform_data,
      max_cpi = NEW.max_cpi, max_cpa = NEW.max_cpa, max_cpc = NEW.max_cpc, max_cpp = NEW.max_cpp,
      responsible_email = NEW.responsible_email,
      main_video_id = NEW.video_id,
      main_vsl_traffic_distribution = NEW.vsl_traffic_distribution,
      main_landers = NEW.landers, main_pre_landers = NEW.pre_landers,
      main_pages_traffic_distribution = NEW.pages_traffic_distribution
    WHERE f.main_funnel_id = OLD.id;
    SELECT v.* INTO NEW FROM public.funnels v WHERE v.id = NEW.id;
    RETURN NEW;
  ELSE
    UPDATE pages.funnels SET main_funnel_id = NULL WHERE main_funnel_id = OLD.id;
    RETURN OLD;
  END IF;
END $function$;
CREATE TRIGGER funnels_view_insert INSTEAD OF INSERT ON public.funnels FOR EACH ROW EXECUTE FUNCTION public.funnels_view_write();
CREATE TRIGGER funnels_view_update INSTEAD OF UPDATE ON public.funnels FOR EACH ROW EXECUTE FUNCTION public.funnels_view_write();
CREATE TRIGGER funnels_view_delete INSTEAD OF DELETE ON public.funnels FOR EACH ROW EXECUTE FUNCTION public.funnels_view_write();
REVOKE ALL ON public.funnels FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.funnels TO service_role;
REVOKE ALL ON FUNCTION public.funnels_view_write() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.funnels_view_write() TO service_role;
CREATE OR REPLACE FUNCTION pages.funnels_sync() RETURNS integer
 LANGUAGE sql
 SET search_path TO ''
AS $function$ SELECT 0 $function$;
CREATE OR REPLACE FUNCTION pages.funnel_for(p_main_funnel uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
BEGIN
  SELECT f.id INTO v_id FROM pages.funnels f WHERE f.main_funnel_id = p_main_funnel;
  RETURN v_id;
END $function$;
