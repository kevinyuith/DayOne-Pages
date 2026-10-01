-- ============================================================================
-- DayOne Pages — the delivery server's keys live in a function, not a table
--
-- pages.server_keys is gone. The server still sends PAGES_SERVER_KEY as p_key
-- (nothing changes on the server or in its .env); the functions it calls now
-- check it with pages.server_key_ok, which compares the key's sha256 with the
-- hashes written in its body. Only the hash is here: the key itself is 64
-- random hex characters (openssl rand -hex 32) and lives only in the server's
-- .env, so publishing the hash gives nothing away.
--
-- A new key (or a revoked one) is a migration that replaces server_key_ok with
-- the new list: add the new hash, deploy the new .env, then drop the old hash.
-- The hash of a key: printf %s "$KEY" | shasum -a 256
--
-- pages.rules_data goes too: the gate's data comes in resolve's `gate` column
-- and the server no longer calls it.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION pages.server_key_ok(p_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex') IN (
    'd97f32db372caae7b416bd07cbf815cae5c82299b00bd03035eb38d1dfd19f09',  -- ignes-cloudpanel (the production server)
    '965069f1ea617fbac9ff89e4ba236a8938191dc803022ed030ab59bb7ce56b1a'   -- local-test (server/.env, local runs)
  );
$function$;

COMMENT ON FUNCTION pages.server_key_ok(text) IS
  'True when p_key is a delivery server key (its sha256 is in the list). A new or revoked key = a migration that replaces this function.';

-- Only the SECURITY DEFINER functions below (same owner) call it.
REVOKE ALL ON FUNCTION pages.server_key_ok(text) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
 RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb, action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text, status_code smallint, preserve_query boolean, content text, placeholders jsonb, gate jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.resolve: invalid key' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
    SELECT m.route_id, m.domain_id, m.priority, m.match_type, m.path_pattern,
           m.conditions, m.action, m.page_id, m.slug, m.slug_id,
           m.content_type, m.content_hash, m.redirect_url, m.status_code,
           m.preserve_query,
           CASE WHEN p_with_content AND m.slug_id IS NOT NULL
                THEN (SELECT p.slugs -> m.slug ->> 'content' FROM pages.pages p WHERE p.id = m.page_id) END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders,
           jsonb_build_object(
             'status', CASE WHEN d.last_check_ok IS TRUE THEN d.status ELSE 'DISABLED' END,
             'gate_slugs', coalesce(d.gate_slugs, '[]'::jsonb),
             'rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active
             ), '[]'::jsonb),
             'funnels', coalesce((
               SELECT jsonb_object_agg(upper(f.code), jsonb_build_object(
                 'split', sp.split,
                 'vsl', (
                   SELECT jsonb_agg(jsonb_build_object('id', v.key, 'weight', (v.value ->> 'weight')::numeric))
                   FROM jsonb_each(f.vsl) v
                   WHERE coalesce((v.value ->> 'weight')::numeric, 0) > 0
                 )
               ))
               FROM pages.funnels f
               CROSS JOIN LATERAL (
                 SELECT jsonb_agg(jsonb_build_object(
                          'page_id', p.id,
                          'content_type', coalesce(sl.s ->> 'content_type', 'text/html; charset=utf-8'),
                          'content_hash', sl.s ->> 'content_hash',
                          'weight', coalesce((f.site -> p.id::text ->> 'weight')::int, 0),
                          'redirect', CASE WHEN coalesce(sl.s ->> 'content_type', '') = 'text/x-redirect'
                                           THEN nullif(btrim(coalesce(sl.s ->> 'content', '')), '') END
                        ) ORDER BY p.created_at, p.id) AS split
                 FROM pages.pages p
                 CROSS JOIN LATERAL (SELECT p.slugs -> '/' AS s) sl
                 WHERE f.site ? p.id::text
                   AND p.scope = 'FUNNEL'
                   AND p.status = 'PUBLISHED'
                   AND coalesce((sl.s ->> 'is_active')::boolean, false)
                   AND coalesce((f.site -> p.id::text ->> 'weight')::int, 0) > 0
               ) sp
               WHERE sp.split IS NOT NULL AND f.code IS NOT NULL AND btrim(f.code) <> ''
             ), '{}'::jsonb)
           ) AS gate
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id;
END $function$;


CREATE OR REPLACE FUNCTION pages.content_get(p_refs jsonb, p_key text)
 RETURNS TABLE(page_id uuid, slug text, content_hash text, content text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.content_get: invalid key' USING ERRCODE = '28000';
  END IF;
  IF coalesce(jsonb_typeof(p_refs), '') <> 'array' OR jsonb_array_length(p_refs) > 50 THEN
    RAISE EXCEPTION 'pages.content_get: refs must be an array of at most 50 { page_id, slug }' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT p.id, r.slug, p.slugs -> r.slug ->> 'content_hash', p.slugs -> r.slug ->> 'content'
    FROM jsonb_to_recordset(p_refs) AS r(page_id uuid, slug text)
    JOIN pages.pages p ON p.id = r.page_id AND p.scope IN ('DOMAIN', 'FUNNEL')
    WHERE p.slugs ? r.slug;
END $function$;


CREATE OR REPLACE FUNCTION pages.log_hit(p_key text, p_domain uuid, p_host text, p_path text, p_outcome text, p_status integer, p_country text, p_device text, p_is_bot boolean, p_referrer_host text, p_ip text, p_user_agent text, p_hostname text DEFAULT NULL::text, p_asn integer DEFAULT NULL::integer, p_as_name text DEFAULT NULL::text, p_cookies text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_route_id uuid DEFAULT NULL::uuid, p_page_id uuid DEFAULT NULL::uuid, p_slug text DEFAULT NULL::text, p_decision text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_redirect_url text DEFAULT NULL::text, p_visit_id text DEFAULT NULL::text, p_rule_label text DEFAULT NULL::text, p_rule text DEFAULT NULL::text, p_rule_tags jsonb DEFAULT NULL::jsonb, p_funnel text DEFAULT NULL::text, p_rule_reason text DEFAULT NULL::text, p_accept_language text DEFAULT NULL::text, p_gate_reason text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_visit text := CASE WHEN p_visit_id ~ '^[0-9a-f]{32}$' THEN p_visit_id END;
  v_id bigint;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.log_hit: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_path, '') !~* '(\.(html|php)|/[^/.]*)$' THEN
    RETURN NULL;
  END IF;

  INSERT INTO pages.hits (domain_id, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip, user_agent,
                          hostname, asn, as_name, cookies, region, route_id, page_id, slug, decision, query, redirect_url, visit_id,
                          rule_label, rule, rule_tags, funnel, rule_reason, accept_language, gate_reason)
  VALUES (
    p_domain,
    left(coalesce(p_host, ''), 253),
    left(coalesce(p_path, ''), 2048),
    CASE WHEN p_outcome IN ('served','redirect','blocked','bot','notfound','error') THEN p_outcome ELSE 'other' END,
    p_status::smallint,
    nullif(upper(coalesce(p_country, '')), ''),
    nullif(p_device, ''),
    coalesce(p_is_bot, false),
    nullif(left(coalesce(p_referrer_host, ''), 253), ''),
    nullif(p_ip, ''),
    nullif(left(coalesce(p_user_agent, ''), 1024), ''),
    nullif(left(coalesce(p_hostname, ''), 253), ''),
    CASE WHEN p_asn > 0 THEN p_asn END,
    nullif(left(coalesce(p_as_name, ''), 256), ''),
    nullif(left(coalesce(p_cookies, ''), 4096), ''),
    CASE WHEN upper(coalesce(p_country, '')) = 'US' THEN nullif(left(trim(coalesce(p_region, '')), 100), '') END,
    p_route_id,
    p_page_id,
    nullif(left(coalesce(p_slug, ''), 512), ''),
    nullif(left(coalesce(p_decision, ''), 64), ''),
    nullif(left(coalesce(p_query, ''), 2048), ''),
    nullif(left(coalesce(p_redirect_url, ''), 2048), ''),
    v_visit,
    nullif(left(coalesce(p_rule_label, ''), 60), ''),
    nullif(left(coalesce(p_rule, ''), 120), ''),
    CASE WHEN coalesce(jsonb_typeof(p_rule_tags), '') = 'array' THEN p_rule_tags END,
    nullif(left(coalesce(p_funnel, ''), 40), ''),
    nullif(left(btrim(coalesce(p_rule_reason, '')), 200), ''),
    nullif(left(btrim(coalesce(p_accept_language, '')), 255), ''),
    CASE WHEN p_gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live', 'domain_disabled', 'domain_locked', 'domain_unlocked') THEN p_gate_reason END
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;


CREATE OR REPLACE FUNCTION pages.log_hit_net(p_key text, p_id bigint, p_asn integer DEFAULT NULL::integer, p_as_name text DEFAULT NULL::text, p_hostname text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.log_hit_net: invalid key' USING ERRCODE = '28000';
  END IF;

  UPDATE pages.hits h
  SET asn = coalesce(h.asn, CASE WHEN p_asn > 0 THEN p_asn END),
      as_name = coalesce(h.as_name, nullif(left(coalesce(p_as_name, ''), 256), '')),
      hostname = coalesce(h.hostname, nullif(left(coalesce(p_hostname, ''), 253), ''))
  WHERE h.id = p_id;
END $function$;


CREATE OR REPLACE FUNCTION pages.log_load(p_key text, p_visit_id text, p_load_ms integer DEFAULT NULL::integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ms integer := CASE WHEN p_load_ms BETWEEN 0 AND 600000 THEN p_load_ms END;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.log_load: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_visit_id, '') !~ '^[0-9a-f]{32}$' THEN
    RETURN true;
  END IF;

  UPDATE pages.hits h
  SET loaded_at = coalesce(h.loaded_at, now()), load_ms = coalesce(h.load_ms, v_ms)
  WHERE h.visit_id = p_visit_id;
  RETURN FOUND;
END $function$;


CREATE OR REPLACE FUNCTION pages.log_click(p_key text, p_visit_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.log_click: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_visit_id, '') !~ '^[0-9a-f]{32}$' THEN
    RETURN true;
  END IF;

  UPDATE pages.hits h
  SET clicked_at = coalesce(h.clicked_at, now()), loaded_at = coalesce(h.loaded_at, now())
  WHERE h.visit_id = p_visit_id;
  RETURN FOUND;
END $function$;


CREATE OR REPLACE FUNCTION pages.log_interact(p_key text, p_visit_id text, p_kind text, p_ms integer DEFAULT NULL::integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_kind text := CASE WHEN p_kind IN ('mouse', 'scroll', 'touch', 'key') THEN p_kind END;
  v_ms integer := CASE WHEN p_ms BETWEEN 0 AND 600000 THEN p_ms END;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
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


CREATE OR REPLACE FUNCTION pages.log_duration(p_key text, p_visit_id text, p_ms integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ms integer := CASE WHEN p_ms BETWEEN 0 AND 14400000 THEN p_ms END;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
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


CREATE OR REPLACE FUNCTION pages.log_signals(p_key text, p_visit_id text, p_signals jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
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


DROP FUNCTION IF EXISTS pages.rules_data(text, text);
DROP TABLE IF EXISTS pages.server_keys;

NOTIFY pgrst, 'reload schema';
