-- ============================================================================
-- DayOne Pages — drop pages.platforms
--
-- The first version of the traffic gate (platforms matched by sub11) was
-- replaced by the rules (pages.rules). pages.platforms was left empty and
-- nothing reads it: neither the dashboard nor the delivery server. Its table,
-- triggers and functions go.
-- ============================================================================

DROP FUNCTION IF EXISTS pages.platform_save(uuid, text, text, jsonb, boolean, integer);
DROP FUNCTION IF EXISTS pages.platform_delete(uuid);
DROP FUNCTION IF EXISTS pages.platforms_list();
DROP FUNCTION IF EXISTS pages.platform_data(text, text);
DROP TABLE IF EXISTS pages.platforms;
DROP FUNCTION IF EXISTS pages.platforms_conditions_check();

NOTIFY pgrst, 'reload schema';
