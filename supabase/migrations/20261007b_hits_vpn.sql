-- Known anonymizers on the hit: is_vpn, vpn_kind, vpn_name.
--
-- The delivery server keeps a local table of known anonymizers
-- (server/src/anondb.php, rebuilt daily): Tor exits (the Tor Project), Apple's
-- iCloud Private Relay egress ranges, X4BNet's VPN and datacenter lists (MIT),
-- AS numbers that only carry a VPN, and the IP-leasing companies seen behind
-- residential ISPs (their blocks, by registry owner — rirdb.php). Each hit
-- records:
--   is_vpn    true = a commercial VPN, a Tor exit or an ISP proxy; false = none
--             of them (iCloud Private Relay and hosting are NOT is_vpn);
--             NULL = no table on the server (unknown)
--   vpn_kind  vpn | tor | isp_proxy | relay | hosting (NULL = none)
--   vpn_name  whose: the VPN's or the leasing company's name, "iCloud Private
--             Relay", "Tor", or the AS's name for a list match
-- INFORMATIONAL ONLY: no rule reads them.
--
-- Only an additive change: new columns and new log_hit parameters with a
-- DEFAULT, so the old server code keeps working until it is deployed.

SET lock_timeout = '5s';

ALTER TABLE pages.hits
  ADD COLUMN is_vpn boolean,
  ADD COLUMN vpn_kind text,
  ADD COLUMN vpn_name text;

COMMENT ON COLUMN pages.hits.is_vpn IS
  'A known commercial VPN, Tor exit or ISP proxy (server/src/anondb.php). iCloud Private Relay and hosting are not. NULL = no table (unknown). Informational only.';
COMMENT ON COLUMN pages.hits.vpn_kind IS
  'vpn | tor | isp_proxy | relay | hosting (anondb.php); NULL = none of them.';
COMMENT ON COLUMN pages.hits.vpn_name IS
  'Whose: the VPN''s or IP-leasing company''s name, iCloud Private Relay, Tor, or the AS''s name for a list match.';

-- The parameter list gains p_is_vpn/p_vpn_kind/p_vpn_name: drop the previous
-- overload first (two overloads that differ only by defaulted parameters are
-- ambiguous to PostgREST).
DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text, jsonb, jsonb);

CREATE OR REPLACE FUNCTION pages.log_hit(p_key text, p_domain uuid, p_host text, p_path text, p_outcome text, p_status integer, p_country text, p_device text, p_is_bot boolean, p_referrer_host text, p_ip text, p_user_agent text, p_hostname text DEFAULT NULL::text, p_asn integer DEFAULT NULL::integer, p_as_name text DEFAULT NULL::text, p_cookies text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_route_id uuid DEFAULT NULL::uuid, p_page_id uuid DEFAULT NULL::uuid, p_slug text DEFAULT NULL::text, p_decision text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_redirect_url text DEFAULT NULL::text, p_visit_id text DEFAULT NULL::text, p_rule_label text DEFAULT NULL::text, p_rule text DEFAULT NULL::text, p_rule_tags jsonb DEFAULT NULL::jsonb, p_funnel text DEFAULT NULL::text, p_rule_reason text DEFAULT NULL::text, p_accept_language text DEFAULT NULL::text, p_gate_reason text DEFAULT NULL::text, p_device_fingerprint jsonb DEFAULT NULL::jsonb, p_ip_block jsonb DEFAULT NULL::jsonb, p_is_vpn boolean DEFAULT NULL::boolean, p_vpn_kind text DEFAULT NULL::text, p_vpn_name text DEFAULT NULL::text)
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

  IF coalesce(p_path, '') !~* '(\\.(html|php)|/[^/.]*)$' THEN
    RETURN NULL;
  END IF;

  INSERT INTO pages.hits (domain_id, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip, user_agent,
                          hostname, asn, as_name, cookies, region, route_id, page_id, slug, decision, query, redirect_url, visit_id,
                          rule_label, rule, rule_tags, funnel, rule_reason, accept_language, gate_reason, device_fingerprint, ip_block,
                          is_vpn, vpn_kind, vpn_name)
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
    CASE WHEN p_gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live', 'domain_disabled', 'domain_locked', 'domain_unlocked') THEN p_gate_reason END,
    CASE WHEN jsonb_typeof(p_device_fingerprint) = 'object' THEN p_device_fingerprint END,
    CASE WHEN jsonb_typeof(p_ip_block) = 'object' THEN p_ip_block END,
    p_is_vpn,
    CASE WHEN p_vpn_kind IN ('vpn', 'tor', 'isp_proxy', 'relay', 'hosting') THEN p_vpn_kind END,
    nullif(left(btrim(coalesce(p_vpn_name, '')), 120), '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;
