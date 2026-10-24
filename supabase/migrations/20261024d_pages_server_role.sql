-- ============================================================================
-- DayOne Pages — the delivery server's own Postgres login (24/10/2026).
--
-- The PHP server (server/src/pg.php) calls the pages.* functions it needs straight through
-- Supabase's pooler (Supavisor, transaction mode: aws-1-us-east-2.pooler.supabase.com:6543, user
-- pages_server.<project ref>) instead of PostgREST, which answers 503 to everything while its
-- schema cache reloads (89 reloads on 23–24/10; 3 s of 503 at 22:15 on 23/10). PostgREST stays as
-- the server's fallback.
--
-- The role may only call those functions — all SECURITY DEFINER with search_path '', and they still
-- check p_key, as through PostgREST. CONNECTION LIMIT 40: the server never takes more than that from
-- the database's 500, whatever its traffic. statement_timeout 6 s (the server waits 5 s for a log
-- call), lock_timeout 3 s.
--
-- PASSWORD: never in this repo. Set apart as a SCRAM verifier (ALTER ROLE pages_server PASSWORD
-- 'SCRAM-SHA-256$4096:…'); the server keeps the password in its config.php (PG_PASSWORD). Without
-- one the role can't log in and the server goes through PostgREST, as before.
--
-- pages.server_grants() grants EXECUTE on every version of those functions: a migration that DROPs
-- and re-creates one of them (a changed signature) must call it again — until then the server logs
-- "postgres refused <fn> (42501 …)" and that call goes through PostgREST.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pages_server') THEN
    CREATE ROLE pages_server WITH LOGIN NOINHERIT CONNECTION LIMIT 40;
  END IF;
END $$;

ALTER ROLE pages_server WITH LOGIN NOINHERIT CONNECTION LIMIT 40;
ALTER ROLE pages_server SET statement_timeout = '6s';
ALTER ROLE pages_server SET lock_timeout = '3s';
ALTER ROLE pages_server SET idle_in_transaction_session_timeout = '10s';

GRANT USAGE ON SCHEMA pages TO pages_server;

CREATE OR REPLACE FUNCTION pages.server_grants()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  f regprocedure;
  n integer := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'pages'::regnamespace
      AND p.proname = ANY (ARRAY[
        'resolve', 'content_get', 'cta_draw_get', 'cta_content_get', 'cta_preview_get',
        'log_hit', 'log_hit_net', 'log_load', 'log_click', 'log_duration', 'log_interact',
        'log_signals', 'log_replay'])
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pages_server', f);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION pages.server_grants() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION pages.server_grants() IS
  'Grants pages_server EXECUTE on the functions the delivery server calls straight through the pooler (server/src/pg.php); returns how many. Run again after a migration that drops and re-creates one of them (20261024d).';

SELECT pages.server_grants();

COMMENT ON ROLE pages_server IS
  'The delivery server''s direct path (Supavisor transaction pooler, server/src/pg.php): may only call the pages.* functions pages.server_grants() lists. Password set apart as a SCRAM verifier, kept in the server''s config.php (PG_PASSWORD) (20261024d).';
