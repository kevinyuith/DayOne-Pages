-- ============================================================================
-- DayOne Pages — drop pages.hit_loads (step 2 of 20260925g)
--
-- Apply AFTER the new delivery server (writes the hit right away, retries a
-- notice that found no hit yet) and the dashboard that reads the notices from
-- pages.hits are live. A notice that only reached hit_loads meanwhile goes to
-- its hit first; then log_hit, log_load and log_click stop touching
-- hit_loads, and the table goes.
-- ============================================================================

UPDATE pages.hits h
SET loaded_at = coalesce(h.loaded_at, l.loaded_at),
    load_ms = coalesce(h.load_ms, l.load_ms),
    clicked_at = coalesce(h.clicked_at, l.clicked_at)
FROM pages.hit_loads l
WHERE l.visit_id = h.visit_id
  AND (h.loaded_at IS NULL OR (h.load_ms IS NULL AND l.load_ms IS NOT NULL) OR (h.clicked_at IS NULL AND l.clicked_at IS NOT NULL));

-- ── log_hit, without hit_loads ──────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text,
                                      text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text);

CREATE FUNCTION pages.log_hit(p_key text, p_domain uuid, p_host text, p_path text, p_outcome text, p_status integer, p_country text,
                              p_device text, p_is_bot boolean, p_referrer_host text, p_ip text, p_user_agent text,
                              p_hostname text DEFAULT NULL, p_asn integer DEFAULT NULL, p_as_name text DEFAULT NULL,
                              p_cookies text DEFAULT NULL, p_region text DEFAULT NULL, p_route_id uuid DEFAULT NULL,
                              p_page_id uuid DEFAULT NULL, p_slug text DEFAULT NULL, p_decision text DEFAULT NULL,
                              p_query text DEFAULT NULL, p_redirect_url text DEFAULT NULL, p_visit_id text DEFAULT NULL,
                              p_rule_label text DEFAULT NULL, p_rule text DEFAULT NULL, p_rule_tags jsonb DEFAULT NULL,
                              p_funnel text DEFAULT NULL, p_rule_reason text DEFAULT NULL)
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
    v_visit,
    nullif(left(coalesce(p_rule_label, ''), 60), ''),
    nullif(left(coalesce(p_rule, ''), 120), ''),
    CASE WHEN coalesce(jsonb_typeof(p_rule_tags), '') = 'array' THEN p_rule_tags END,
    nullif(left(coalesce(p_funnel, ''), 40), ''),
    nullif(left(btrim(coalesce(p_rule_reason, '')), 200), '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

-- ── The notices, only on the hit ────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.log_load(text, text, integer);
DROP FUNCTION IF EXISTS pages.log_click(text, text);

-- The page loaded (load event): returns false when the hit isn't written yet (the server retries).
CREATE FUNCTION pages.log_load(p_key text, p_visit_id text, p_load_ms integer DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_ms integer := CASE WHEN p_load_ms BETWEEN 0 AND 600000 THEN p_load_ms END;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
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

-- The visitor clicked out of the page (a click also means it loaded): false = no hit yet (the server retries).
CREATE FUNCTION pages.log_click(p_key text, p_visit_id text)
RETURNS boolean
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

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text)',
    'pages.log_load(text, text, integer)',
    'pages.log_click(text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, service_role', fn);
  END LOOP;
END $$;

DROP TABLE IF EXISTS pages.hit_loads;

NOTIFY pgrst, 'reload schema';
