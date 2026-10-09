-- ============================================================================
-- DayOne Pages — signed purges: no ORIGIN_URL or PURGE_TOKEN in any env (09/10)
--
-- A write that changes what a domain serves purges the delivery server's cache
-- of that host (POST /_purge), so it takes effect at once instead of within
-- CACHE_TTL (30 s). Until 09/10 the dashboard needed ORIGIN_URL + PURGE_TOKEN in
-- its env — production never had them: no /_purge reached the server from 03/10
-- to 09/10 — and dayone-main never purged.
--
-- Now the purge token (= PURGE_TOKEN in the server's config.php) lives in Vault,
-- 'dayone_pages.purge_token' (set through pages.ai_secret_set, like the Kimi
-- key), and pages.purge_request(host) returns a signed request: HMAC-SHA256 of
-- "host|unix time" with the token. The dashboards POST it to
-- https://<host>/_purge — the server answers /_purge on every domain it serves —
-- and the server checks the signature (2 minutes either way,
-- server/src/handlers.php). The token never leaves the database: a domain whose
-- DNS no longer points to us only ever sees a signature that purges that host's
-- cache for 2 minutes. Only verified domains (last_check_ok) get one. The caller
-- does the HTTP itself: pg_net works in batches that wait for the slowest
-- request, and the crons' edge-function calls hold it for up to 300 s.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.ai_secret_allowed(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_name IN ('dayone_pages.moonshot_api_key', 'dayone_pages.purge_token')
$$;

-- The Vault description by name (every secret got the Kimi key's).
CREATE OR REPLACE FUNCTION pages.ai_secret_set(p_name text, p_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT pages.ai_secret_allowed(p_name) THEN
    RAISE EXCEPTION 'ai_secret_set: unknown secret name' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.id INTO v_id FROM vault.secrets s WHERE s.name = p_name;
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN
    IF v_id IS NOT NULL THEN
      DELETE FROM vault.secrets WHERE id = v_id;
    END IF;
    RETURN;
  END IF;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(btrim(p_secret), p_name, CASE p_name
      WHEN 'dayone_pages.purge_token' THEN 'DayOne Pages: the delivery server''s purge token (= PURGE_TOKEN in its config.php); signs pages.purge_request'
      ELSE 'DayOne Pages: API key for the copy-angle rewrite of template variations'
    END);
  ELSE
    PERFORM vault.update_secret(v_id, btrim(p_secret));
  END IF;
END $$;

-- A signed purge of the delivery server's cache for one host, or NULL when the
-- host isn't a verified domain or the token isn't set. service_role only.
CREATE OR REPLACE FUNCTION pages.purge_request(p_host text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- The server's normalize_host: lowercase, no port, no trailing dot, no www.
  v_host  text := regexp_replace(regexp_replace(split_part(lower(btrim(coalesce(p_host, ''))), ':', 1), '\.$', ''), '^www\.', '');
  v_token text;
  v_time  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pages.domains d WHERE d.domain = v_host AND d.last_check_ok) THEN
    RETURN NULL;
  END IF;
  SELECT d.decrypted_secret INTO v_token FROM vault.decrypted_secrets d WHERE d.name = 'dayone_pages.purge_token';
  IF v_token IS NULL OR v_token = '' THEN
    RETURN NULL;
  END IF;
  v_time := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  RETURN jsonb_build_object(
    'url', 'https://' || v_host || '/_purge',
    'host', v_host,
    'time', v_time,
    'signature', encode(extensions.hmac(v_host || '|' || v_time, v_token, 'sha256'), 'hex')
  );
END $$;

REVOKE ALL ON FUNCTION pages.purge_request(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.purge_request(text) TO service_role;

COMMENT ON FUNCTION pages.purge_request(text) IS
  'A signed purge of the delivery server''s cache for one verified domain: POST {"host": host} to url with X-Purge-Time = time and X-Purge-Signature = signature (HMAC-SHA256 of host|time with the Vault secret dayone_pages.purge_token = PURGE_TOKEN in the server''s config.php; the server accepts it for 2 minutes). NULL = not a verified domain, or no token. 20261009c.';
