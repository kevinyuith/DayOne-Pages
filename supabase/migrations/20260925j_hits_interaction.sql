-- ============================================================================
-- DayOne Pages — the hit records the visitor's first interaction
--
-- The load notice's script (server/src/beacon.php) also reports the first
-- real interaction with the page: the mouse moved or pressed, a wheel scroll,
-- a touch or a key ("i=<kind>&t=<ms>"). log_interact puts it on the visit's
-- hit, only the first one:
--
--   pages.hits.interacted_at   when the notice came; NULL = none
--   pages.hits.interaction     its kind: mouse | scroll | touch | key
--   pages.hits.interaction_ms  ms from the navigation start, as the browser said
--
-- Like log_load/log_click, it returns false when the hit isn't written yet
-- (the server retries). It only measures: nothing served depends on it.
-- ============================================================================

ALTER TABLE pages.hits
  ADD COLUMN IF NOT EXISTS interacted_at timestamptz,
  ADD COLUMN IF NOT EXISTS interaction text,
  ADD COLUMN IF NOT EXISTS interaction_ms integer;

ALTER TABLE pages.hits DROP CONSTRAINT IF EXISTS hits_interaction_check;
ALTER TABLE pages.hits ADD CONSTRAINT hits_interaction_check CHECK (interaction IN ('mouse', 'scroll', 'touch', 'key'));

COMMENT ON COLUMN pages.hits.interacted_at IS 'When the browser reported the visitor''s first interaction (mouse, wheel, touch or key); NULL = none reported.';
COMMENT ON COLUMN pages.hits.interaction IS 'The first interaction''s kind: mouse, scroll, touch or key.';
COMMENT ON COLUMN pages.hits.interaction_ms IS 'ms from the navigation start to the first interaction, as the browser reported it.';

DROP FUNCTION IF EXISTS pages.log_interact(text, text, text, integer);

-- The visitor's first interaction: false = no hit yet (the server retries).
CREATE FUNCTION pages.log_interact(p_key text, p_visit_id text, p_kind text, p_ms integer DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_kind text := CASE WHEN p_kind IN ('mouse', 'scroll', 'touch', 'key') THEN p_kind END;
  v_ms integer := CASE WHEN p_ms BETWEEN 0 AND 600000 THEN p_ms END;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.log_interact: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_visit_id, '') !~ '^[0-9a-f]{32}$' OR v_kind IS NULL THEN
    RETURN true;
  END IF;

  -- Only the first one: a later notice finds the hit and leaves it as it is.
  UPDATE pages.hits h
  SET interacted_at = coalesce(h.interacted_at, now()),
      interaction = CASE WHEN h.interacted_at IS NULL THEN v_kind ELSE h.interaction END,
      interaction_ms = CASE WHEN h.interacted_at IS NULL THEN v_ms ELSE h.interaction_ms END
  WHERE h.visit_id = p_visit_id;
  RETURN FOUND;
END $function$;

REVOKE ALL ON FUNCTION pages.log_interact(text, text, text, integer) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_interact(text, text, text, integer) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
