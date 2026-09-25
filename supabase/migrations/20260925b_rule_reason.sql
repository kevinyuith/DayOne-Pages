-- ============================================================================
-- DayOne Pages — a rule's reason, recorded in the hit log
--
-- Each rule says WHY it flags a click (e.g. "Datacenter IP", "Headless
-- browser"). When the rule catches a click, the delivery server records the
-- reason with the hit (pages.hits.rule_reason), next to the label and the
-- rule's name, and the Logs screen shows it.
--
--   * pages.rules.reason (text, up to 200 characters, '' = none).
--   * pages.hits.rule_reason.
--   * rule_save gains p_reason and rules_list returns reason.
--   * resolve's gate carries each rule's reason to the server.
--   * log_hit gains p_rule_reason (DEFAULT NULL: servers that don't send it
--     keep logging).
-- ============================================================================

-- ── Columns ─────────────────────────────────────────────────────────────────

ALTER TABLE pages.rules ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rules_reason_len' AND conrelid = 'pages.rules'::regclass) THEN
    ALTER TABLE pages.rules ADD CONSTRAINT rules_reason_len CHECK (char_length(reason) <= 200);
  END IF;
END $$;
COMMENT ON COLUMN pages.rules.reason IS 'Why the rule flags the click (e.g. "Datacenter IP"); recorded in pages.hits.rule_reason when it matches. '''' = none.';

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS rule_reason text;
COMMENT ON COLUMN pages.hits.rule_reason IS 'The reason of the rule that caught the click (pages.rules.reason); NULL = no rule or no reason.';

-- ── rule_save / rules_list ──────────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.rule_save(uuid, text, text, jsonb, jsonb, boolean);

CREATE FUNCTION pages.rule_save(p_id uuid, p_name text, p_label text, p_tags jsonb, p_conditions jsonb, p_is_active boolean,
                                p_reason text DEFAULT '')
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO pages.rules (name, label, tags, conditions, is_active, reason, position)
    VALUES (btrim(p_name), btrim(p_label), coalesce(p_tags, '[]'::jsonb), coalesce(p_conditions, '{}'::jsonb), coalesce(p_is_active, true),
            btrim(coalesce(p_reason, '')),
            (SELECT coalesce(max(x.position), 0) + 1 FROM pages.rules x))
    RETURNING id INTO v_id;
  ELSE
    UPDATE pages.rules r
    SET name = btrim(p_name),
        label = btrim(p_label),
        tags = coalesce(p_tags, '[]'::jsonb),
        conditions = coalesce(p_conditions, '{}'::jsonb),
        is_active = coalesce(p_is_active, true),
        reason = btrim(coalesce(p_reason, ''))
    WHERE r.id = p_id
    RETURNING r.id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'rule_save: rule not found' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;
  RETURN v_id;
END $function$;

DROP FUNCTION IF EXISTS pages.rules_list();

CREATE FUNCTION pages.rules_list()
RETURNS TABLE(id uuid, name text, label text, tags jsonb, conditions jsonb, "position" integer, is_active boolean, reason text)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT r.id, r.name, r.label, r.tags, r.conditions, r.position, r.is_active, r.reason
  FROM pages.rules r
  ORDER BY r.position, r.created_at;
$function$;

-- ── resolve: each rule of the gate carries its reason ───────────────────────

CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb, action text,
              page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text, status_code smallint,
              preserve_query boolean, content text, placeholders jsonb, gate jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
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
           CASE WHEN p_with_content AND m.slug_id IS NOT NULL
                THEN (SELECT p.slugs -> m.slug ->> 'content' FROM pages.pages p WHERE p.id = m.page_id) END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders,
           jsonb_build_object(
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
                          'weight', coalesce((f.site -> p.id::text ->> 'weight')::int, 0)
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

-- ── log_hit: the rule's reason ──────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text,
                                      text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text);

CREATE FUNCTION pages.log_hit(p_key text, p_domain uuid, p_host text, p_path text, p_outcome text, p_status integer, p_country text,
                              p_device text, p_is_bot boolean, p_referrer_host text, p_ip text, p_user_agent text,
                              p_hostname text DEFAULT NULL, p_asn integer DEFAULT NULL, p_as_name text DEFAULT NULL,
                              p_cookies text DEFAULT NULL, p_region text DEFAULT NULL, p_route_id uuid DEFAULT NULL,
                              p_page_id uuid DEFAULT NULL, p_slug text DEFAULT NULL, p_decision text DEFAULT NULL,
                              p_query text DEFAULT NULL, p_redirect_url text DEFAULT NULL, p_visit_id text DEFAULT NULL,
                              p_rule_label text DEFAULT NULL, p_rule text DEFAULT NULL, p_rule_tags jsonb DEFAULT NULL,
                              p_funnel text DEFAULT NULL, p_rule_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.log_hit: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_path, '') !~* '(\.(html|php)|/[^/.]*)$' THEN
    RETURN;
  END IF;

  INSERT INTO pages.hits (domain_id, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip, user_agent,
                          hostname, asn, as_name, cookies, region, route_id, page_id, slug, decision, query, redirect_url, visit_id,
                          rule_label, rule, rule_tags, funnel, rule_reason)
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
    CASE WHEN p_visit_id ~ '^[0-9a-f]{32}$' THEN p_visit_id END,
    nullif(left(coalesce(p_rule_label, ''), 60), ''),
    nullif(left(coalesce(p_rule, ''), 120), ''),
    CASE WHEN coalesce(jsonb_typeof(p_rule_tags), '') = 'array' THEN p_rule_tags END,
    nullif(left(coalesce(p_funnel, ''), 40), ''),
    nullif(left(btrim(coalesce(p_rule_reason, '')), 200), '')
  );
END $function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION pages.rule_save(uuid, text, text, jsonb, jsonb, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rule_save(uuid, text, text, jsonb, jsonb, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION pages.rules_list() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rules_list() TO service_role;
REVOKE ALL ON FUNCTION pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text,
                                     text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text,
                                        text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
