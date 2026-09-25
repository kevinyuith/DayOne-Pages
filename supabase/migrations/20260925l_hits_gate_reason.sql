-- ============================================================================
-- DayOne Pages — why a clean click didn't go to the funnel
--
-- pages.hits.gate_reason, set by the gate (server/src/rules.php) when no rule
-- matched and the click got the domain's page instead of a funnel:
--
--   slug_not_allowed  the slug isn't "/" nor one of the domain's gate_slugs
--   no_funnel_token   the sub1 has no [F…] token (or there is no sub1)
--   funnel_not_live   the [F…] funnel has no live page (unknown code, or no
--                     published, active page with a share above 0); the code
--                     is in pages.hits.funnel
--
-- NULL otherwise (a rule matched, the funnel served it, or no gate). The Logs
-- show it in the Reason column. log_hit gains p_gate_reason with a default, so
-- a server that doesn't send it keeps logging.
-- ============================================================================

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS gate_reason text;
ALTER TABLE pages.hits DROP CONSTRAINT IF EXISTS hits_gate_reason_check;
ALTER TABLE pages.hits ADD CONSTRAINT hits_gate_reason_check CHECK (gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live'));
COMMENT ON COLUMN pages.hits.gate_reason IS 'Why a clean click (no rule matched) got the domain''s page instead of a funnel: slug_not_allowed, no_funnel_token or funnel_not_live; NULL otherwise.';

DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text, text);

CREATE FUNCTION pages.log_hit(p_key text, p_domain uuid, p_host text, p_path text, p_outcome text, p_status integer, p_country text,
                              p_device text, p_is_bot boolean, p_referrer_host text, p_ip text, p_user_agent text,
                              p_hostname text DEFAULT NULL, p_asn integer DEFAULT NULL, p_as_name text DEFAULT NULL,
                              p_cookies text DEFAULT NULL, p_region text DEFAULT NULL, p_route_id uuid DEFAULT NULL,
                              p_page_id uuid DEFAULT NULL, p_slug text DEFAULT NULL, p_decision text DEFAULT NULL,
                              p_query text DEFAULT NULL, p_redirect_url text DEFAULT NULL, p_visit_id text DEFAULT NULL,
                              p_rule_label text DEFAULT NULL, p_rule text DEFAULT NULL, p_rule_tags jsonb DEFAULT NULL,
                              p_funnel text DEFAULT NULL, p_rule_reason text DEFAULT NULL, p_accept_language text DEFAULT NULL,
                              p_gate_reason text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_visit text := CASE WHEN p_visit_id ~ '^[0-9a-f]{32}$' THEN p_visit_id END;
  v_id bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
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
    CASE WHEN p_gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live') THEN p_gate_reason END
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

REVOKE ALL ON FUNCTION pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
