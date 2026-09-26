-- ============================================================================
-- DayOne Pages — how long the visitor stayed on the funnel page
--
-- The load notice's script (server/src/beacon.php, only on a funnel's page
-- served by the gate) reports "d=<ms>" whenever the page is hidden or left
-- (visibilitychange → hidden, pagehide): the time since the page opened.
-- log_duration keeps the longest one on the visit's hit:
--
--   pages.hits.duration_ms  ms the page stayed open (the last time it was
--                           hidden or left); NULL = never reported
--
-- Like log_load/log_click, it returns false when the hit isn't written yet
-- (the server retries). Up to 4 hours; it only measures.
-- ============================================================================

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS duration_ms integer;
COMMENT ON COLUMN pages.hits.duration_ms IS 'ms the page stayed open, from its start to the last time it was hidden or left, as the browser reported it (the longest report); NULL = never reported.';

DROP FUNCTION IF EXISTS pages.log_duration(text, text, integer);

-- The time on the page: false = no hit yet (the server retries).
CREATE FUNCTION pages.log_duration(p_key text, p_visit_id text, p_ms integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_ms integer := CASE WHEN p_ms BETWEEN 0 AND 14400000 THEN p_ms END;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.log_duration: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_visit_id, '') !~ '^[0-9a-f]{32}$' OR v_ms IS NULL THEN
    RETURN true;
  END IF;

  -- The page may be hidden several times (tab switches): the longest report wins.
  UPDATE pages.hits h
  SET duration_ms = greatest(coalesce(h.duration_ms, 0), v_ms)
  WHERE h.visit_id = p_visit_id;
  RETURN FOUND;
END $function$;

REVOKE ALL ON FUNCTION pages.log_duration(text, text, integer) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_duration(text, text, integer) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
