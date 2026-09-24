-- ============================================================================
-- DayOne Pages — a load notice that arrives after the click notice keeps its time
--
-- Both beacons (load "t=<ms>" and click "c=1") are logged after the response,
-- fire-and-forget, so the click can reach the database first: log_click then
-- inserts the visit with load_ms NULL, and log_load (ON CONFLICT DO NOTHING)
-- dropped the load time. log_load now fills load_ms when the row exists
-- without it.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.log_load(p_key text, p_visit_id text, p_load_ms integer DEFAULT NULL::integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.log_load: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_visit_id, '') !~ '^[0-9a-f]{32}$' THEN
    RETURN;
  END IF;

  INSERT INTO pages.hit_loads (visit_id, load_ms)
  VALUES (p_visit_id, CASE WHEN p_load_ms BETWEEN 0 AND 600000 THEN p_load_ms END)
  ON CONFLICT (visit_id) DO UPDATE SET load_ms = coalesce(pages.hit_loads.load_ms, excluded.load_ms);
END $function$;
