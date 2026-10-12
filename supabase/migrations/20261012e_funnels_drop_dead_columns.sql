-- ============================================================================
-- pages.funnels loses three dead columns (the owner, 12/10/2026: "vamos tirar as antigas"):
--   * campaigns — the sub1 list that once routed a click to a funnel; the gate routes by the
--     sub1's [F…] token, the column is empty on every row and nothing calls
--     pages.funnel_campaigns_set / funnel_campaigns_list (dropped with their trigger);
--   * main_landers, main_pre_landers — dayone-main's old A/B lists, empty on every row; dayone-main
--     stopped selecting and writing them (d5de28d72).
-- The compatibility view public.funnels keeps its columns (`landers` / `pre_landers` read as
-- empty lists) and its write function stops writing them.
-- Still read, so they stay for now: main_video_id, main_vsl_traffic_distribution,
-- main_pages_traffic_distribution.
-- ============================================================================

DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.funnels IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock pages.funnels in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

-- Nothing is lost: every row is empty.
DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM pages.funnels
             WHERE campaigns <> '[]'::jsonb
                OR coalesce(main_landers, '[]'::jsonb) NOT IN ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
                OR coalesce(main_pre_landers, '[]'::jsonb) NOT IN ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)) THEN
    RAISE EXCEPTION 'a funnel still has campaigns / landers / pre_landers';
  END IF;
END $chk$;

-- The compatibility view: same columns and types, the two old lists always empty.
CREATE OR REPLACE VIEW public.funnels AS
 SELECT main_funnel_id AS id,
    code::character varying(20) AS funnel_id,
    name::character varying(255) AS name,
    platform::character varying(100) AS platform,
    niche::character varying(100) AS niche,
    region::character varying(20) AS region,
    status::character varying(20) AS status,
    created_at,
    updated_at,
    platform_data,
    max_cpi,
    max_cpa,
    max_cpc,
    max_cpp,
    responsible_email,
    main_video_id AS video_id,
    main_vsl_traffic_distribution AS vsl_traffic_distribution,
    '[]'::jsonb AS landers,
    '[]'::jsonb AS pre_landers,
    main_pages_traffic_distribution AS pages_traffic_distribution
   FROM pages.funnels f
  WHERE main_funnel_id IS NOT NULL;

-- Its write function stops writing the two lists.
DO $rw$
DECLARE
  def text := pg_get_functiondef('public.funnels_view_write()'::regprocedure);
  new text;
BEGIN
  new := replace(def, 'main_video_id, main_vsl_traffic_distribution, main_landers, main_pre_landers, main_pages_traffic_distribution',
                      'main_video_id, main_vsl_traffic_distribution, main_pages_traffic_distribution');
  new := replace(new, 'NEW.video_id, NEW.vsl_traffic_distribution, NEW.landers, NEW.pre_landers, NEW.pages_traffic_distribution',
                      'NEW.video_id, NEW.vsl_traffic_distribution, NEW.pages_traffic_distribution');
  new := replace(new, 'main_landers = NEW.landers, main_pre_landers = NEW.pre_landers,', '');
  IF new ~ 'main_landers|main_pre_landers' OR new = def THEN
    RAISE EXCEPTION 'public.funnels_view_write: unexpected definition';
  END IF;
  EXECUTE new;
END $rw$;

DROP TRIGGER IF EXISTS trg_pages_funnels_campaigns_check ON pages.funnels;
DROP FUNCTION IF EXISTS pages.funnels_campaigns_check();
DROP FUNCTION IF EXISTS pages.funnel_campaigns_set(uuid, jsonb);
DROP FUNCTION IF EXISTS pages.funnel_campaigns_list();

ALTER TABLE pages.funnels
  DROP COLUMN campaigns,
  DROP COLUMN main_landers,
  DROP COLUMN main_pre_landers;

NOTIFY pgrst, 'reload schema';
