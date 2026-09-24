-- ============================================================================
-- DayOne Pages — addition to the `pages` schema
--
-- Apply ON TOP of the schema created by `20260916_pages_schema.sql` (the same
-- Supabase project, ref cfiisyxaxttoexiyfdho). This file does not create the
-- schema or the four base tables: it adds what the dashboard and the
-- delivery server need. Everything here lives in `pages`; nothing is created in
-- `public` or in any other schema. It is idempotent: it can be run again.
--
-- What goes in:
--   1. domain verification columns in pages.domains
--   2. CHECK: the `bot` condition is only accepted on BLOCK routes
--   3. pages.server_keys      — delivery server keys (sha256 hash)
--   5. pages.resolve()        — routes + content in one call, for the server
--   6. pages.swap_route_priority() — atomic priority swap between routes
--   7. match_routes() semantics documented
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 1. Domain verification                                                   │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Behind Cloudflare the A record cannot be verified (it resolves to
-- Cloudflare IPs). The dashboard verifies by fetching `/_health` on the domain and
-- checking our server's marker; the result is stored here, with no history.

ALTER TABLE pages.domains
  ADD COLUMN IF NOT EXISTS last_checked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_check_ok    boolean,
  ADD COLUMN IF NOT EXISTS last_check_error text;

COMMENT ON COLUMN pages.domains.last_checked_at  IS 'Last /_health check made by the dashboard.';
COMMENT ON COLUMN pages.domains.last_check_ok    IS 'Did the last check find our server behind the domain?';
COMMENT ON COLUMN pages.domains.last_check_error IS 'Reason for the last check failure (short text, no sensitive data).';


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 2. `bot` is only for blocking                                            │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Bot detection exists to stop scrapers and crawlers (403/404/410/451),
-- never to change the content served. The dashboard refuses it too; the CHECK is the
-- guarantee that does not depend on the UI.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_domain_routes_bot_only_block'
      AND conrelid = 'pages.domain_routes'::regclass
  ) THEN
    ALTER TABLE pages.domain_routes
      ADD CONSTRAINT ck_domain_routes_bot_only_block
      CHECK (NOT (conditions ? 'bot') OR action = 'BLOCK');
  END IF;
END $$;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 3. pages.server_keys — delivery server keys                              │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- The PHP server does NOT get the service key. It calls pages.resolve() with the
-- publishable (anon) key plus its own key, whose sha256 lives here. If the
-- server key leaks: revoke the row (revoked_at) and issue another one.
--
-- Seed (run by hand, once per server; the plaintext key goes only in server/.env):
--   INSERT INTO pages.server_keys (name, key_hash)
--   VALUES ('origin-1', encode(sha256(convert_to('<openssl rand -hex 32>', 'UTF8')), 'hex'));

CREATE TABLE IF NOT EXISTS pages.server_keys (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  key_hash    text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

COMMENT ON TABLE  pages.server_keys          IS 'Delivery server keys. Only the hash; the plaintext key lives in the server''s .env.';
COMMENT ON COLUMN pages.server_keys.key_hash IS 'encode(sha256(convert_to(key, ''UTF8'')), ''hex'').';

ALTER TABLE pages.server_keys ENABLE ROW LEVEL SECURITY;
-- The schema's default privileges gave SELECT to `authenticated`; not here.
REVOKE ALL ON pages.server_keys FROM authenticated;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 5. pages.resolve(host, path, key) — the delivery server's resolver       │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- match_routes() returns the candidate routes but not the HTML; the server
-- would need a second call per slug. This function joins the two into a
-- single round trip, and it is the ONLY door for `anon` in this schema:
--
--   • SECURITY DEFINER: runs as the owner, so it reaches match_routes() and
--     page_slugs even with `anon` having no privilege on any table.
--   • Requires a valid key in server_keys; a wrong key raises 28000
--     (invalid_authorization_specification), which PostgREST returns as 403.
--     Without a key, whoever has only the anon key resolves nothing.
--
-- Consumer semantics: walk the rows in order; the FIRST one whose
-- `conditions` match decides. SERVE with slug_id NULL answers 404 — it does not skip
-- to the next one, so a misconfigured route shows up instead of disappearing.

CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text)
RETURNS TABLE (
  route_id        uuid,
  domain_id       uuid,
  priority        integer,
  match_type      text,
  path_pattern    text,
  conditions      jsonb,
  action          text,
  page_id         uuid,
  slug            text,
  slug_id         uuid,
  content_type    text,
  content_hash    text,
  redirect_url    text,
  status_code     smallint,
  preserve_query  boolean,
  content         text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.resolve: invalid key' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
    SELECT m.route_id, m.domain_id, m.priority, m.match_type, m.path_pattern,
           m.conditions, m.action, m.page_id, m.slug, m.slug_id,
           m.content_type, m.content_hash, m.redirect_url, m.status_code,
           m.preserve_query,
           CASE WHEN m.slug_id IS NOT NULL THEN s.content END AS content
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.page_slugs AS s ON s.id = m.slug_id;
END $$;

COMMENT ON FUNCTION pages.resolve(text, text, text) IS
  'Routes from match_routes(host, path) + slug content, in one call. Requires a key from pages.server_keys. '
  'Called by the delivery server via POST /rest/v1/rpc/resolve with Content-Profile: pages.';

-- `anon` gets USAGE on the schema (without it, it cannot see the function) and EXECUTE only
-- on it. It still has no SELECT on any table and none of the other functions.
GRANT USAGE ON SCHEMA pages TO anon;
REVOKE ALL ON ALL TABLES IN SCHEMA pages FROM anon;
REVOKE ALL ON FUNCTION pages.resolve(text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text) TO anon, service_role;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 6. pages.swap_route_priority(a, b) — move a route up/down                │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- UNIQUE (domain_id, priority) prevents swapping with two separate UPDATEs. Here the
-- swap goes through a temporary value below the domain's minimum, all in a
-- single transaction. Only the service_role (dashboard) calls it.

CREATE OR REPLACE FUNCTION pages.swap_route_priority(p_a uuid, p_b uuid)
RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_pa   integer;
  v_pb   integer;
  v_da   uuid;
  v_db   uuid;
  v_tmp  integer;
BEGIN
  IF p_a = p_b THEN RETURN; END IF;

  SELECT r.priority, r.domain_id INTO v_pa, v_da FROM pages.domain_routes r WHERE r.id = p_a FOR UPDATE;
  SELECT r.priority, r.domain_id INTO v_pb, v_db FROM pages.domain_routes r WHERE r.id = p_b FOR UPDATE;

  IF v_pa IS NULL OR v_pb IS NULL THEN
    RAISE EXCEPTION 'swap_route_priority: route not found';
  END IF;
  IF v_da <> v_db THEN
    RAISE EXCEPTION 'swap_route_priority: the routes belong to different domains';
  END IF;

  SELECT min(r.priority) - 1 INTO v_tmp FROM pages.domain_routes r WHERE r.domain_id = v_da;

  UPDATE pages.domain_routes SET priority = v_tmp WHERE id = p_a;
  UPDATE pages.domain_routes SET priority = v_pa  WHERE id = p_b;
  UPDATE pages.domain_routes SET priority = v_pb  WHERE id = p_a;
END $$;

REVOKE ALL ON FUNCTION pages.swap_route_priority(uuid, uuid) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.swap_route_priority(uuid, uuid) TO service_role;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 7. match_routes() semantics, now settled                                 │
-- └──────────────────────────────────────────────────────────────────────────┘

COMMENT ON FUNCTION pages.match_routes(text, text) IS
  'Domain rules that match (host, path), in priority order, + fallback (default_page_id). '
  'Only matches the PATH; `conditions` goes back to the serving layer to evaluate. '
  'Consumer semantics: the FIRST row whose conditions pass decides; '
  'SERVE with slug_id NULL answers 404 and does NOT fall through to the next one. '
  'conditions format: {"countries":["BR"],"devices":["mobile","tablet","desktop"],'
  '"query":{"utm_source":"present"|"absent"|{"equals":"x"}},"referrer":"text","bot":true}; '
  '`bot` only on action=BLOCK (ck_domain_routes_bot_only_block).';
