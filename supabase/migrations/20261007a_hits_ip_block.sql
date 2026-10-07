-- The IP's block on the hit: who the registry delegated it to.
--
-- The delivery server keeps a local table of the five registries' delegations
-- (server/src/rirdb.php, from their delegated-extended files) and records, on
-- every hit, the block that holds the IP — range, registry, country, date,
-- status and its owner's id — next to the owner id and country of the AS that
-- routes it, and how the two relate: "same" (the ISP's own block), "other"
-- (another owner, same country) or "foreign" (another owner registered in
-- another country). A residential ISP's clicks from a block owned by someone
-- else — an IP-leasing broker's — is the pattern of "ISP" proxies.
-- INFORMATIONAL ONLY: no rule reads it.
--
-- Only an additive change: a new column (NULL = no table on the server, or an
-- IP in no delegated block) and a new log_hit parameter with a DEFAULT, so the
-- old server code keeps working until it is deployed.

-- Adding a nullable column is instant, but it waits for the table's lock: give
-- up rather than hold the log's inserts behind a long reader.
SET lock_timeout = '5s';

ALTER TABLE pages.hits
  ADD COLUMN ip_block jsonb;

COMMENT ON COLUMN pages.hits.ip_block IS
  'The registry delegation of the IP''s block (server/src/rirdb.php): {range, rir, cc, date, status, holder, asn_holder, asn_cc, relation}; relation = same | other | foreign (the block''s owner vs the routing AS''s). Informational only. NULL = no table or no delegated block.';

-- The parameter list gains p_ip_block, so drop the previous overload first —
-- CREATE OR REPLACE alone would leave it behind, and two overloads that differ
-- only by a defaulted parameter are ambiguous to PostgREST.
DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION pages.log_hit(p_key text, p_domain uuid, p_host text, p_path text, p_outcome text, p_status integer, p_country text, p_device text, p_is_bot boolean, p_referrer_host text, p_ip text, p_user_agent text, p_hostname text DEFAULT NULL::text, p_asn integer DEFAULT NULL::integer, p_as_name text DEFAULT NULL::text, p_cookies text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_route_id uuid DEFAULT NULL::uuid, p_page_id uuid DEFAULT NULL::uuid, p_slug text DEFAULT NULL::text, p_decision text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_redirect_url text DEFAULT NULL::text, p_visit_id text DEFAULT NULL::text, p_rule_label text DEFAULT NULL::text, p_rule text DEFAULT NULL::text, p_rule_tags jsonb DEFAULT NULL::jsonb, p_funnel text DEFAULT NULL::text, p_rule_reason text DEFAULT NULL::text, p_accept_language text DEFAULT NULL::text, p_gate_reason text DEFAULT NULL::text, p_device_fingerprint jsonb DEFAULT NULL::jsonb, p_ip_block jsonb DEFAULT NULL::jsonb)
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
                          rule_label, rule, rule_tags, funnel, rule_reason, accept_language, gate_reason, device_fingerprint, ip_block)
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
    CASE WHEN jsonb_typeof(p_ip_block) = 'object' THEN p_ip_block END
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;
