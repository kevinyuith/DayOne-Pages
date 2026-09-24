-- ============================================================================
-- DayOne Pages — drop pages.detection_rules
--
-- The table (20260922) only backed a CRUD list on the Settings screen: no
-- database function, view or the delivery server ever read it, so a rule
-- there changed nothing. It was empty. Bot detection that actually runs is
-- the delivery server's user-agent check, the per-domain block_bots switch
-- and route conditions. Its indexes go with it.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pages.detection_rules) THEN
    RAISE EXCEPTION 'pages.detection_rules is not empty; refusing to drop it' USING ERRCODE = 'check_violation';
  END IF;
END $$;

DROP TABLE IF EXISTS pages.detection_rules;

NOTIFY pgrst, 'reload schema';
