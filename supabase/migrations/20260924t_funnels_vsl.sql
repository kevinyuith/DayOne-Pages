-- ============================================================================
-- DayOne Pages — every funnel in pages.funnels, with its VTurb A/B test (vsl)
--
-- pages.funnels gets a row for every dayone-main funnel (public.funnels), with
-- its code (F1…) and name, kept in sync by pages.funnels_sync(), and:
--
--   vturb_group_id  the funnel's A/B test ("comparison group") in VTurb
--   vsl             the videos in that test and their share of the traffic:
--                   { "<VTurb player id>": { "weight": 10, "name": "VSL-….mp4" } }
--                   — like `site` for the pages. A replica of the test: the
--                   dashboard writes the test in VTurb and then saves here what
--                   VTurb has.
--   vsl_synced_at   when `vsl` was last read from / written to VTurb.
--
-- This is a new scope that lives in the pages schema: nothing of dayone-main
-- is changed. Only this migration reads dayone-main's VTurb mirror
-- (vturb.folder_map / vturb.group_players), once, to seed the replica.
-- ============================================================================

ALTER TABLE pages.funnels
  ADD COLUMN IF NOT EXISTS code           text,
  ADD COLUMN IF NOT EXISTS name           text,
  ADD COLUMN IF NOT EXISTS vturb_group_id text,
  ADD COLUMN IF NOT EXISTS vsl            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS vsl_synced_at  timestamptz;

COMMENT ON COLUMN pages.funnels.code IS 'The dayone-main funnel code (public.funnels.funnel_id: F1, F2…), kept by pages.funnels_sync().';
COMMENT ON COLUMN pages.funnels.name IS 'The dayone-main funnel name (public.funnels.name), kept by pages.funnels_sync().';
COMMENT ON COLUMN pages.funnels.vturb_group_id IS 'The funnel''s A/B test in VTurb (comparison group id). NULL = no test.';
COMMENT ON COLUMN pages.funnels.vsl IS '{ "<VTurb player id>": { "weight": 0-100, "name": "…" } }: the videos of the funnel''s VTurb A/B test and their traffic share (a replica; the dashboard writes VTurb first).';
COMMENT ON COLUMN pages.funnels.vsl_synced_at IS 'When vsl was last read from or written to VTurb.';

-- Validates the vsl replica.
CREATE OR REPLACE FUNCTION pages.funnels_vsl_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.vsl), '') <> 'object' THEN
    RAISE EXCEPTION 'funnels.vsl must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR v IN SELECT key, value FROM jsonb_each(NEW.vsl) LOOP
    IF v.key !~ '^[0-9a-f]{24}$'
       OR coalesce(jsonb_typeof(v.value), '') <> 'object'
       OR coalesce(jsonb_typeof(v.value -> 'weight'), '') <> 'number'
       OR (v.value ->> 'weight')::numeric NOT BETWEEN 0 AND 100
       OR coalesce(jsonb_typeof(v.value -> 'name'), 'string') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'funnels.vsl: invalid video %', v.key USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_funnels_vsl_check ON pages.funnels;
CREATE TRIGGER trg_pages_funnels_vsl_check BEFORE INSERT OR UPDATE OF vsl ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.funnels_vsl_check();

-- A row for every dayone-main funnel, with its current code and name (only
-- rows that changed are written). Returns how many rows were inserted/updated.
CREATE OR REPLACE FUNCTION pages.funnels_sync()
RETURNS int
LANGUAGE sql
SET search_path = ''
AS $$
  WITH up AS (
    INSERT INTO pages.funnels AS t (main_funnel_id, code, name)
    SELECT f.id, f.funnel_id, f.name FROM public.funnels f
    ON CONFLICT (main_funnel_id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name
    WHERE t.code IS DISTINCT FROM EXCLUDED.code OR t.name IS DISTINCT FROM EXCLUDED.name
    RETURNING 1
  )
  SELECT count(*)::int FROM up
$$;

-- The pages.funnels row of a dayone-main funnel, created on first use (with code and name).
CREATE OR REPLACE FUNCTION pages.funnel_for(p_main_funnel uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO pages.funnels (main_funnel_id, code, name)
  SELECT f.id, f.funnel_id, f.name FROM public.funnels f WHERE f.id = p_main_funnel
  ON CONFLICT (main_funnel_id) DO NOTHING;
  SELECT f.id INTO v_id FROM pages.funnels f WHERE f.main_funnel_id = p_main_funnel;
  RETURN v_id;
END $$;

-- Saves the replica of the funnel's VTurb A/B test (after reading or writing VTurb).
CREATE OR REPLACE FUNCTION pages.funnel_vsl_save(p_funnel uuid, p_group text, p_vsl jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.funnels f SET vturb_group_id = p_group, vsl = p_vsl, vsl_synced_at = now() WHERE f.id = p_funnel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_vsl_save: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- The dayone-main VSLs (not archived), read-only: to show a video's VSL
-- (status, language, pitch, copy, editor) next to it. video_ids are the VTurb
-- player ids the VSL pipeline recorded.
CREATE OR REPLACE FUNCTION pages.main_vsls()
RETURNS TABLE (vsl_id uuid, title text, funnel_status text, language text, pitch integer,
               copywriter text, editor text, video_ids text[], video_url text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT e.id, e.title, e.funnel_status, e.language, e.pitch, e.copywriter_name, e.editor_name,
         e.video_id::text[], nullif(e.metadata ->> 'video_url', '')
  FROM public.v_vsl_explorer e
  WHERE e.archived_at IS NULL
$$;

-- ── Seed ────────────────────────────────────────────────────────────────────

SELECT pages.funnels_sync();

-- One-time replica of each funnel's VTurb A/B test from dayone-main's mirror.
UPDATE pages.funnels t
SET vturb_group_id = fm.ab_group_id,
    vsl = coalesce((SELECT jsonb_object_agg(gp.player_id, jsonb_build_object('weight', gp.traffic_percentage, 'name', gp.name))
                    FROM vturb.group_players gp WHERE gp.group_id = fm.ab_group_id), '{}'::jsonb),
    vsl_synced_at = (SELECT max(gp.synced_at) FROM vturb.group_players gp WHERE gp.group_id = fm.ab_group_id)
FROM vturb.folder_map fm
WHERE fm.funnel_code = upper(t.code) AND fm.ab_group_id IS NOT NULL;

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.funnels_sync()',
    'pages.funnel_for(uuid)',
    'pages.funnel_vsl_save(uuid, text, jsonb)',
    'pages.main_vsls()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION pages.funnels_vsl_check() FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
