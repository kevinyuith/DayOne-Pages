-- ============================================================================
-- DayOne Pages — vturb_player_find reads dayone-main's vturb schema as its owner
--
-- service_role (the dashboard) can't read vturb.folder_players & co. The
-- function runs as its owner (SECURITY DEFINER, empty search_path) and only
-- returns one player's id and name; still service_role-only.
-- ============================================================================

ALTER FUNCTION pages.vturb_player_find(text) SECURITY DEFINER;

REVOKE ALL ON FUNCTION pages.vturb_player_find(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.vturb_player_find(text) TO service_role;

NOTIFY pgrst, 'reload schema';
