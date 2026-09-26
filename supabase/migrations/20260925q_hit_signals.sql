-- ============================================================================
-- DayOne Pages — the visit's device/behavior signals, on the hit
--
-- The beacon script (only a funnel's page served by the gate carries it) now
-- also reports what JavaScript can tell about the device, as a hint that the
-- visitor may be a bot — INFORMATIONAL ONLY: nothing is blocked or labeled
-- from it. Two payloads, merged here into one column:
--
--   capabilities (sent at the load event): webdriver, platform, max touch
--   points, cores, device memory, languages/plugins counts, screen and
--   viewport sizes + DPR, the pointer (fine/coarse/none) and hover media,
--   window.chrome, userAgentData (mobile, platform), cookies enabled.
--   session counts (sent when the page is hidden or left): trusted mousemove,
--   mousedown, wheel, scroll, touchstart, keydown and click counts — 0 on a
--   device that has the pointer means nobody drove it.
--
-- pages.log_signals marks the visit's hit like the other beacon functions
-- (returns false while the hit isn't written yet, so the server retries).
-- ============================================================================

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS signals jsonb;

COMMENT ON COLUMN pages.hits.signals IS 'Device/behavior signals the beacon collected on the funnel page (informational only): capabilities (webdriver, platform, touch points, cores, memory, languages/plugins, screen/viewport, pointer/hover, chrome, userAgentData, cookies) and session counts (mouse, scroll, touch, key, click events).';

CREATE OR REPLACE FUNCTION pages.log_signals(p_key text, p_visit_id text, p_signals jsonb)
RETURNS boolean
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
    RAISE EXCEPTION 'pages.log_signals: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_visit_id, '') !~ '^[0-9a-f]{32}$'
     OR coalesce(jsonb_typeof(p_signals), '') <> 'object'
     OR p_signals = '{}'::jsonb
     OR octet_length(p_signals::text) > 2048 THEN
    RETURN true;
  END IF;

  -- The capabilities (at load) and the session counts (when hidden/left) come
  -- in different notices: top-level merge, the newest value of a key wins.
  UPDATE pages.hits h
  SET signals = coalesce(h.signals, '{}'::jsonb) || p_signals
  WHERE h.visit_id = p_visit_id;
  RETURN FOUND;
END $function$;

REVOKE ALL ON FUNCTION pages.log_signals(text, text, jsonb) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_signals(text, text, jsonb) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
