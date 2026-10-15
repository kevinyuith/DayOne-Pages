-- ============================================================================
-- DayOne Pages — upsell videos uploaded to VTurb (the owner, 14/10/2026: "em VSL você pode fazer o
-- upload do vídeo e é colocado no próprio VTurb"; "os vídeos upload vão para a pasta Vendor do
-- VTurb"; through dayone-main's worker, a default player without VTurb's CTA).
--
-- The Upsells editor's VSL stage uploads the file to Supabase Storage (bucket `media`, under
-- upsells/<funnel id>/) and queues it here. dayone-main's VTurb worker (vturb/pipeline-worker.js,
-- job "upsell_video") claims it, uploads it to VTurb (S3 multipart), creates the default player in
-- the VTurb folder "Vendor", waits for the transcode and records the player id. The editor then puts
-- the player in the group's VSLs at 0% (added_at marks it, so a removed one isn't put back).
--
-- Its own queue, not vturb.pipeline_queue: that one is a VSL's (vsl_id NOT NULL, FK to public.vsl,
-- read by dayone-main's screens) and nothing of it changes. The worker only claims jobs of the kinds
-- it declares, so an older worker never sees these.
--
-- Writes only through the functions: upsell_video_add / upsell_video_retry / upsell_video_mark_added (the dashboard),
-- upsell_video_claim / upsell_video_heartbeat (the worker); upsell_videos_for reads a funnel's.
-- ============================================================================

CREATE TABLE pages.upsell_videos (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  funnel_id       uuid REFERENCES pages.upsell_funnels(id) ON DELETE SET NULL,
  step            text NOT NULL CHECK (step IN ('up1', 'up2', 'up3', 'up4', 'up5')),
  group_id        text NOT NULL CHECK (group_id ~ '^g[a-z0-9]{1,12}$'),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  storage_path    text NOT NULL CHECK (storage_path ~ '^upsells/[0-9a-f-]{36}/[0-9a-f-]{36}\.(mp4|mov|webm)$'),
  size_bytes      bigint CHECK (size_bytes > 0),
  content_type    text NOT NULL CHECK (content_type IN ('video/mp4', 'video/quicktime', 'video/webm')),
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uploading', 'transcoding', 'done', 'failed')),
  video_id        text,
  player_id       text,
  attempt_count   integer NOT NULL DEFAULT 0,
  worker_id       text,
  last_heartbeat  timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  error_message   text,
  added_at        timestamptz,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pages_upsell_videos_funnel ON pages.upsell_videos (funnel_id, created_at DESC);
CREATE INDEX idx_pages_upsell_videos_open ON pages.upsell_videos (created_at) WHERE state NOT IN ('done', 'failed');
COMMENT ON TABLE pages.upsell_videos IS
  'Upsell videos uploaded from the Upsells editor (VSL stage): the file in Storage (media/upsells/…), queued for dayone-main''s VTurb worker (job upsell_video), which creates the default player in the VTurb folder Vendor. player_id goes into the group''s VSLs (added_at). Written only by the upsell_video_* functions.';

ALTER TABLE pages.upsell_videos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.upsell_videos FROM public, anon, authenticated;
GRANT SELECT ON pages.upsell_videos TO service_role;

-- ── The dashboard ───────────────────────────────────────────────────────────

-- Queues an uploaded file. The object must already be in Storage. NULL = no such funnel.
CREATE OR REPLACE FUNCTION pages.upsell_video_add(p_funnel uuid, p_step text, p_group text, p_name text, p_path text, p_size bigint, p_type text, p_by text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pages.upsell_funnels f WHERE f.id = p_funnel) THEN
    RETURN NULL;
  END IF;
  IF p_path IS NULL OR split_part(p_path, '/', 2) <> p_funnel::text THEN
    RAISE EXCEPTION 'upsell video: the file is not this funnel''s' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'media' AND o.name = p_path) THEN
    RAISE EXCEPTION 'upsell video: the file was not uploaded' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO pages.upsell_videos (funnel_id, step, group_id, name, storage_path, size_bytes, content_type, created_by)
  VALUES (p_funnel, p_step, p_group, btrim(p_name), p_path, p_size, p_type, p_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- The editor put the player in the group's VSLs (it isn't put back after being removed).
CREATE OR REPLACE FUNCTION pages.upsell_video_mark_added(p_id bigint)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE pages.upsell_videos SET added_at = coalesce(added_at, now()), updated_at = now()
  WHERE id = p_id AND state = 'done' AND player_id IS NOT NULL;
$$;

-- A failed one goes back to the queue (a fresh start: the worker uploads it again).
CREATE OR REPLACE FUNCTION pages.upsell_video_retry(p_id bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE pages.upsell_videos
  SET state = 'pending', attempt_count = 0, video_id = NULL, player_id = NULL, error_message = NULL,
      worker_id = NULL, last_heartbeat = NULL, started_at = NULL, finished_at = NULL, updated_at = now()
  WHERE id = p_id AND state = 'failed'
  RETURNING true;
$$;

-- A funnel's uploads, newest first (the editor's VSL stage).
CREATE OR REPLACE FUNCTION pages.upsell_videos_for(p_funnel uuid)
RETURNS TABLE(id bigint, step text, group_id text, name text, size_bytes bigint, state text, player_id text,
              error_message text, attempt_count integer, added_at timestamptz, created_at timestamptz, finished_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT v.id, v.step, v.group_id, v.name, v.size_bytes, v.state, v.player_id, v.error_message, v.attempt_count,
         v.added_at, v.created_at, v.finished_at
  FROM pages.upsell_videos v
  WHERE v.funnel_id = p_funnel
  ORDER BY v.created_at DESC
  LIMIT 100
$$;

-- ── dayone-main's VTurb worker ─────────────────────────────────────────────

-- The oldest pending job, or one whose worker stopped beating for 20 minutes (a restart mid-upload);
-- after 3 attempts such a job fails instead. FOR UPDATE SKIP LOCKED: two workers never take the same.
CREATE OR REPLACE FUNCTION pages.upsell_video_claim(p_worker_id text)
RETURNS TABLE(id bigint, name text, storage_path text, content_type text, size_bytes bigint,
              video_id text, player_id text, attempt_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id bigint;
BEGIN
  UPDATE pages.upsell_videos u
  SET state = 'failed', finished_at = now(), updated_at = now(),
      error_message = coalesce(u.error_message, 'the worker stopped 3 times while processing it')
  WHERE u.state IN ('uploading', 'transcoding') AND u.last_heartbeat < now() - interval '20 minutes' AND u.attempt_count >= 3;

  SELECT u.id INTO v_id
  FROM pages.upsell_videos u
  WHERE u.state = 'pending'
     OR (u.state IN ('uploading', 'transcoding') AND u.last_heartbeat < now() - interval '20 minutes')
  ORDER BY u.created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE pages.upsell_videos u
  SET state = 'uploading', worker_id = p_worker_id, started_at = coalesce(u.started_at, now()), last_heartbeat = now(),
      attempt_count = u.attempt_count + 1, error_message = NULL, updated_at = now()
  WHERE u.id = v_id;
  RETURN QUERY
    SELECT u.id, u.name, u.storage_path, u.content_type, u.size_bytes, u.video_id, u.player_id, u.attempt_count
    FROM pages.upsell_videos u WHERE u.id = v_id;
END $$;

-- The worker's progress: { state?, video_id?, player_id?, error_message? } (a key left out stays).
CREATE OR REPLACE FUNCTION pages.upsell_video_heartbeat(p_id bigint, p_patch jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE pages.upsell_videos u
  SET last_heartbeat = now(),
      state = coalesce(p_patch ->> 'state', u.state),
      video_id = coalesce(p_patch ->> 'video_id', u.video_id),
      player_id = coalesce(p_patch ->> 'player_id', u.player_id),
      error_message = CASE WHEN p_patch ? 'error_message' THEN left(p_patch ->> 'error_message', 1000) ELSE u.error_message END,
      finished_at = CASE WHEN p_patch ->> 'state' IN ('done', 'failed') THEN now() ELSE u.finished_at END,
      updated_at = now()
  WHERE u.id = p_id;
$$;

REVOKE ALL ON FUNCTION pages.upsell_video_add(uuid, text, text, text, text, bigint, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_video_mark_added(bigint) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_video_retry(bigint) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_videos_for(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_video_claim(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_video_heartbeat(bigint, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.upsell_video_add(uuid, text, text, text, text, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_video_mark_added(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_video_retry(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_videos_for(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_video_claim(text) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_video_heartbeat(bigint, jsonb) TO service_role;
