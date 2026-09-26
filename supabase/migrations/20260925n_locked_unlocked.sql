-- ============================================================================
-- DayOne Pages — rename the domain statuses BLOCKED → LOCKED, ALLOWED → UNLOCKED
--
-- The vocabulary reads better with the gate: a LOCKED domain keeps the click
-- behind the gate (rules run, but it always gets the domain's page); an
-- UNLOCKED one has no gate at all (every slug goes straight to the funnel).
-- The hits' gate reasons follow: domain_blocked → domain_locked,
-- domain_allowed → domain_unlocked.
-- ============================================================================

-- ── The status values ───────────────────────────────────────────────────────

ALTER TABLE pages.domains DROP CONSTRAINT IF EXISTS domains_status_check;
UPDATE pages.domains SET status = 'LOCKED' WHERE status = 'BLOCKED';
UPDATE pages.domains SET status = 'UNLOCKED' WHERE status = 'ALLOWED';
ALTER TABLE pages.domains ADD CONSTRAINT domains_status_check
  CHECK (status IN ('ACTIVE', 'DISABLED', 'LOCKED', 'UNLOCKED'));

COMMENT ON COLUMN pages.domains.status IS 'ACTIVE (normal), DISABLED (404 everywhere), LOCKED (rules run, but never the funnel — always the domain page), UNLOCKED (rules ignored, every slug goes to the funnel of the sub1).';

-- ── pages.hits.gate_reason: the renamed reasons ─────────────────────────────

ALTER TABLE pages.hits DROP CONSTRAINT IF EXISTS hits_gate_reason_check;
UPDATE pages.hits SET gate_reason = 'domain_locked' WHERE gate_reason = 'domain_blocked';
UPDATE pages.hits SET gate_reason = 'domain_unlocked' WHERE gate_reason = 'domain_allowed';
ALTER TABLE pages.hits ADD CONSTRAINT hits_gate_reason_check
  CHECK (gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live', 'domain_disabled', 'domain_locked', 'domain_unlocked'));

COMMENT ON COLUMN pages.hits.gate_reason IS 'Why a click didn''t go to a funnel (the Reason column): slug_not_allowed, no_funnel_token, funnel_not_live, or by the domain''s status — domain_disabled, domain_locked, domain_unlocked.';

-- log_hit accepts the renamed reasons (the same function as 20260925m, only
-- the gate_reason CASE changes).
CREATE OR REPLACE FUNCTION pages.log_hit(p_key text, p_domain uuid, p_host text, p_path text, p_outcome text, p_status integer, p_country text,
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
    CASE WHEN p_gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live', 'domain_disabled', 'domain_locked', 'domain_unlocked') THEN p_gate_reason END
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

REVOKE ALL ON FUNCTION pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text) TO anon, service_role;

-- match_routes: the renamed statuses (resolve itself just passes d.status
-- through in the gate column — nothing to change there).
CREATE OR REPLACE FUNCTION pages.match_routes(p_host text, p_path text)
RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb, action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text, status_code smallint, preserve_query boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  WITH req AS (
    SELECT pages.normalize_host(p_host) AS host, pages.normalize_path(p_path) AS path
  ),
  dom AS (
    SELECT d.id, d.site
    FROM pages.domains d, req
    WHERE d.status IN ('ACTIVE', 'DISABLED', 'LOCKED', 'UNLOCKED') AND d.domain = req.host
  )
  SELECT NULL::uuid AS route_id, dom.id AS domain_id, 0 AS priority, 'PAGE' AS match_type,
         NULL::text AS path_pattern, '{}'::jsonb AS conditions, 'SERVE' AS action,
         p.id AS page_id, req.path AS slug,
         CASE WHEN sl.content_hash IS NOT NULL THEN md5(dom.id::text || ':' || p.id::text || ':' || req.path)::uuid END AS slug_id,
         sl.content_type,
         sl.content_hash,
         NULL::text AS redirect_url, NULL::smallint AS status_code, true AS preserve_query
  FROM dom
  CROSS JOIN LATERAL (
    SELECT k::uuid AS page_id FROM jsonb_object_keys(dom.site) k
  ) owned
  JOIN pages.pages p ON p.id = owned.page_id AND p.status = 'PUBLISHED'
  CROSS JOIN req
  LEFT JOIN LATERAL (
    SELECT p.slugs -> req.path AS s
  ) pg ON true
  LEFT JOIN LATERAL (
    SELECT pg.s ->> 'content_hash' AS content_hash,
           coalesce(pg.s ->> 'content_type', 'text/html; charset=utf-8') AS content_type
    WHERE coalesce((pg.s ->> 'is_active')::boolean, false)
  ) sl ON true
  ORDER BY p.created_at, p.id
$function$;

NOTIFY pgrst, 'reload schema';
