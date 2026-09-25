-- ============================================================================
-- DayOne Pages — the load/click notices go on the hit (step 1 of 2)
--
-- pages.hit_loads merges into pages.hits: a hit gets loaded_at, load_ms and
-- clicked_at, set by the browser's notices (beacon.php → log_load / log_click,
-- by visit_id). A notice can arrive BEFORE its hit row is written (the hit is
-- written after the response): the new delivery server writes the hit right
-- away (the ASN/hostname go in a second write, log_hit_net) and retries a
-- notice that found no hit yet (log_load/log_click return false).
--
-- This step keeps the old path working while the old server is live: the
-- notices still ALSO go into hit_loads, and a hit written after its notice
-- takes what hit_loads has. Step 2 (20260925h, after the new server and
-- dashboard are live) drops hit_loads.
--
--   * log_hit returns the new hit's id (old servers ignore it).
--   * log_hit_net(p_key, p_id, p_asn, p_as_name, p_hostname): the network
--     lookups, after the hit.
--   * log_load / log_click return whether the hit was found. A click also
--     means the page loaded (like hit_loads, where the click created the row).
--   * funnel_page_stats counts from hits (views = loaded, clicks = clicked).
-- ============================================================================

-- ── Columns ─────────────────────────────────────────────────────────────────

ALTER TABLE pages.hits
  ADD COLUMN IF NOT EXISTS loaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS load_ms integer,
  ADD COLUMN IF NOT EXISTS clicked_at timestamptz;

COMMENT ON COLUMN pages.hits.loaded_at IS 'When the browser reported the page loaded (load event, or a click); NULL = never reported.';
COMMENT ON COLUMN pages.hits.load_ms IS 'ms from the navigation start to the load event, as the browser reported it.';
COMMENT ON COLUMN pages.hits.clicked_at IS 'When the visitor first clicked out of the page (a link or data-href that navigates); NULL = no click.';

UPDATE pages.hits h
SET loaded_at = l.loaded_at, load_ms = l.load_ms, clicked_at = l.clicked_at
FROM pages.hit_loads l
WHERE l.visit_id = h.visit_id AND h.loaded_at IS NULL;

-- ── log_hit: returns the id; takes a notice that came first (transition) ────

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

  -- Transition: a notice that arrived before this hit is in hit_loads (step 2 removes this).
  IF v_visit IS NOT NULL THEN
    UPDATE pages.hits h
    SET loaded_at = l.loaded_at, load_ms = l.load_ms, clicked_at = l.clicked_at
    FROM pages.hit_loads l
    WHERE h.id = v_id AND l.visit_id = v_visit;
  END IF;

  RETURN v_id;
END $function$;

-- ── The network lookups, after the hit ──────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.log_hit_net(p_key text, p_id bigint, p_asn integer DEFAULT NULL, p_as_name text DEFAULT NULL, p_hostname text DEFAULT NULL)
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
    RAISE EXCEPTION 'pages.log_hit_net: invalid key' USING ERRCODE = '28000';
  END IF;

  UPDATE pages.hits h
  SET asn = coalesce(h.asn, CASE WHEN p_asn > 0 THEN p_asn END),
      as_name = coalesce(h.as_name, nullif(left(coalesce(p_as_name, ''), 256), '')),
      hostname = coalesce(h.hostname, nullif(left(coalesce(p_hostname, ''), 253), ''))
  WHERE h.id = p_id;
END $function$;

-- ── The notices: on the hit (and, for now, hit_loads) ───────────────────────

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

  -- Transition (step 2 removes it).
  INSERT INTO pages.hit_loads (visit_id, load_ms)
  VALUES (p_visit_id, v_ms)
  ON CONFLICT (visit_id) DO UPDATE SET load_ms = coalesce(pages.hit_loads.load_ms, excluded.load_ms);

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

  -- Transition (step 2 removes it).
  INSERT INTO pages.hit_loads (visit_id, clicked_at)
  VALUES (p_visit_id, now())
  ON CONFLICT (visit_id) DO UPDATE SET clicked_at = coalesce(pages.hit_loads.clicked_at, excluded.clicked_at);

  UPDATE pages.hits h
  SET clicked_at = coalesce(h.clicked_at, now()), loaded_at = coalesce(h.loaded_at, now())
  WHERE h.visit_id = p_visit_id;
  RETURN FOUND;
END $function$;

-- ── Funnel page numbers, from the hits ──────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.funnel_page_stats(p_since timestamptz)
RETURNS TABLE(funnel_page_id uuid, views bigint, clicks bigint)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT p.funnel_page_id, count(*), count(h.clicked_at)
  FROM pages.hits h
  JOIN pages.pages p ON p.id = h.page_id
  WHERE h.created_at >= p_since
    AND h.loaded_at IS NOT NULL
    AND NOT h.is_bot
    AND p.funnel_page_id IS NOT NULL
  GROUP BY 1
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text)',
    'pages.log_hit_net(text, bigint, integer, text, text)',
    'pages.log_load(text, text, integer)',
    'pages.log_click(text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, service_role', fn);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION pages.funnel_page_stats(timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.funnel_page_stats(timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
