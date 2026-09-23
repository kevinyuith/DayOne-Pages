-- ============================================================================
-- DayOne Pages — database text in English
--
-- Project rule (AGENTS.md): everything that lives in the database is written
-- in English — names, values, COMMENT ON, RAISE messages and comments inside
-- function bodies. Identifiers and values already were; this migration
-- translates the rest. No behavior change:
--
-- - COMMENT ON for tables, columns and functions: text only.
-- - domain_routes_validate, folders_no_cycle, swap_route_priority, log_hit:
--   same signature (CREATE OR REPLACE keeps grants and owner), same body as
--   the live one, with only the RAISE messages / the inline comment
--   translated. Error codes stay the same, so the dashboard actions that map
--   errors by code (e.g. 23514) keep working.
-- ============================================================================

-- ── Functions: messages and inline comments ────────────────────────────────

CREATE OR REPLACE FUNCTION pages.domain_routes_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.match_type IN ('EXACT','PREFIX') AND NEW.path_pattern IS NOT NULL THEN
    NEW.path_pattern := pages.normalize_path(NEW.path_pattern);
  ELSIF NEW.match_type = 'REGEX' AND NEW.path_pattern IS NOT NULL THEN
    BEGIN
      PERFORM '/' ~ NEW.path_pattern;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'domain_routes.path_pattern: invalid regex (%): %', NEW.path_pattern, SQLERRM
        USING ERRCODE = 'check_violation';
    END;
  END IF;

  IF NEW.slug IS NOT NULL THEN
    NEW.slug := pages.normalize_path(NEW.slug);
  END IF;

  IF NEW.status_code IS NULL THEN
    NEW.status_code := CASE NEW.action WHEN 'REDIRECT' THEN 302 WHEN 'BLOCK' THEN 404 END;
  END IF;

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION pages.folders_no_cycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  cur   uuid := NEW.parent_id;
  depth int  := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'a folder cannot be inside itself' USING ERRCODE = 'check_violation';
  END IF;
  WHILE cur IS NOT NULL LOOP
    depth := depth + 1;
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'a folder cannot be inside one of its subfolders' USING ERRCODE = 'check_violation';
    END IF;
    IF depth > 20 THEN
      RAISE EXCEPTION 'folders nested too deep (max 20 levels)' USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cur FROM pages.folders WHERE id = cur;
  END LOOP;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION pages.swap_route_priority(p_a uuid, p_b uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    RAISE EXCEPTION 'swap_route_priority: routes belong to different domains';
  END IF;

  SELECT min(r.priority) - 1 INTO v_tmp FROM pages.domain_routes r WHERE r.domain_id = v_da;

  UPDATE pages.domain_routes SET priority = v_tmp WHERE id = p_a;
  UPDATE pages.domain_routes SET priority = v_pa  WHERE id = p_b;
  UPDATE pages.domain_routes SET priority = v_pb  WHERE id = p_a;
END $function$;

CREATE OR REPLACE FUNCTION pages.log_hit(p_key text, p_domain uuid, p_host text, p_path text, p_outcome text, p_status integer, p_country text, p_device text, p_is_bot boolean, p_referrer_host text, p_ip text, p_user_agent text, p_hostname text DEFAULT NULL::text, p_asn integer DEFAULT NULL::integer, p_as_name text DEFAULT NULL::text, p_cookies text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_route_id uuid DEFAULT NULL::uuid, p_page_id uuid DEFAULT NULL::uuid, p_slug text DEFAULT NULL::text, p_decision text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_redirect_url text DEFAULT NULL::text, p_visit_id text DEFAULT NULL::text)
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
                          hostname, asn, as_name, cookies, region, route_id, page_id, slug, decision, query, redirect_url, visit_id)
  VALUES (
    -- No resolved route: PHP sends NULL (domain without a default page), so look it up by host.
    coalesce(p_domain, (SELECT d.id FROM pages.domains d WHERE d.domain = pages.normalize_host(p_host))),
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
    CASE WHEN p_visit_id ~ '^[0-9a-f]{32}$' THEN p_visit_id END
  );
END $function$;

-- ── Tables ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE pages.detection_rules IS 'Rules to detect bots and suspicious visitors by pattern (UA, IP, country, etc.).';
COMMENT ON TABLE pages.domain_routes IS 'Domain routing rules, evaluated by priority (lowest first). The path is matched in the database (match_routes); `conditions` are matched by the serving layer.';
COMMENT ON TABLE pages.domains IS 'The domain that receives the request. Only status=ACTIVE answers in match_routes(). Purchase/DNS live in management.buy_domains / cloudflare_buy_domains — this is serving only.';
COMMENT ON TABLE pages.folders IS 'Nested folders that organize the dashboard pages screen.';
COMMENT ON TABLE pages.hit_loads IS 'Browser notice that the page loaded (load event). load_ms = ms since navigation start.';
COMMENT ON TABLE pages.hits IS 'One row per request handled by the delivery server. Feeds the dashboard cards/chart/logs. Holds raw IP/UA (PII).';
COMMENT ON TABLE pages.page_slugs IS 'One slug of a page with its content. (page_id, slug) is unique. is_active=false takes the slug offline without losing the content.';
COMMENT ON TABLE pages.pages IS 'The page as an editorial unit. Content does NOT live here: it lives in page_slugs, one per slug. Only status=PUBLISHED is served by match_routes(); DRAFT/ARCHIVED are invisible to the domain.';
COMMENT ON TABLE pages.server_keys IS 'Delivery server keys. Hash only; the plain key lives in the server .env.';

-- ── Columns ────────────────────────────────────────────────────────────────

COMMENT ON COLUMN pages.detection_rules.classification IS 'Classification on match: bot or suspicious.';
COMMENT ON COLUMN pages.detection_rules.pattern IS 'Pattern: regex for UA, CIDR for IP, ISO-2 for country, number for rate, string for keyword.';
COMMENT ON COLUMN pages.detection_rules.priority IS 'Evaluation priority (lowest first). Default 100.';
COMMENT ON COLUMN pages.detection_rules.type IS 'Rule type: user_agent (regex), ip_pattern (CIDR), country (ISO-2), rate_limit (requests/sec), keyword (in path/UA).';

COMMENT ON COLUMN pages.domain_routes.conditions IS 'Conditions beyond the path; the database does not evaluate them. {} = always matches.';
COMMENT ON COLUMN pages.domain_routes.path_pattern IS 'EXACT/PREFIX: canonical path. REGEX: POSIX against the canonical path. ANY: NULL.';
COMMENT ON COLUMN pages.domain_routes.slug IS 'SERVE: slug of the page to serve. NULL = the request path is the slug.';

COMMENT ON COLUMN pages.domains.block_bots IS 'Blocks crawlers/automated connections (answers 403) before any route. Does not swap the page — only blocks.';
COMMENT ON COLUMN pages.domains.default_page_id IS 'Fallback when no rule matches: serves the request path as a slug of this page.';
COMMENT ON COLUMN pages.domains.filter IS 'Domain filter conditions (country, device, query, referrer). NULL = no filter. Does not accept the `bot` key.';
COMMENT ON COLUMN pages.domains.filter_fail_page_id IS 'Page served when the visitor fails the filter.';
COMMENT ON COLUMN pages.domains.filter_pass_page_id IS 'Page served when the visitor passes the filter.';
COMMENT ON COLUMN pages.domains.last_check_error IS 'Reason for the last failed check (short text, no sensitive data).';
COMMENT ON COLUMN pages.domains.last_check_ok IS 'Did the last check find our server behind the domain?';
COMMENT ON COLUMN pages.domains.last_checked_at IS 'Last /_health check made by the dashboard.';

COMMENT ON COLUMN pages.folders.color IS 'Color key chosen in the UI; NULL = default color.';
COMMENT ON COLUMN pages.folders.parent_id IS 'Parent folder; NULL = root.';

COMMENT ON COLUMN pages.hits.as_name IS 'ASN name, e.g. "GOOGLE-CLOUD-PLATFORM - Google LLC, US".';
COMMENT ON COLUMN pages.hits.asn IS 'Autonomous system number (ASN) of the IP, via Team Cymru. NULL if not found.';
COMMENT ON COLUMN pages.hits.cookies IS 'Raw Cookie header of the request (up to 4096 chars). PII.';
COMMENT ON COLUMN pages.hits.decision IS '"<action> · <rule type>", e.g. SERVE · FALLBACK, BLOCK · BOTGATE. NONE = no route matched.';
COMMENT ON COLUMN pages.hits.hostname IS 'Hostname from reverse DNS of the IP (helps spot bots/data centers).';
COMMENT ON COLUMN pages.hits.page_id IS 'Page served by the route (no FK).';
COMMENT ON COLUMN pages.hits.query IS 'Raw query string of the request (without the "?"), up to 2048 chars. PII.';
COMMENT ON COLUMN pages.hits.redirect_url IS 'Location returned when the hit is a redirect (final URL), up to 2048 chars. PII.';
COMMENT ON COLUMN pages.hits.region IS 'Visitor state (Cloudflare cf-region), only when country = US.';
COMMENT ON COLUMN pages.hits.route_id IS 'Route that decided the response (no FK: the route may have been deleted). NULL = none matched.';
COMMENT ON COLUMN pages.hits.slug IS 'Slug served by the route.';
COMMENT ON COLUMN pages.hits.visit_id IS 'Visit id (dop_v cookie) when the response was an HTML page with the load beacon. Joins with pages.hit_loads.';

COMMENT ON COLUMN pages.page_slugs.content_hash IS 'md5(content), generated. Used as the ETag.';
COMMENT ON COLUMN pages.page_slugs.slug IS 'Canonical path within the page: lowercase, starts with /, no trailing slash (root = "/").';

COMMENT ON COLUMN pages.pages.folder_id IS 'Folder of the page in the dashboard screen; NULL = root.';
COMMENT ON COLUMN pages.pages.kind IS 'PRESELL | ADVERTORIAL | VSL | CHECKOUT | SAFE (clean page for reviewer/bot) | OTHER';

COMMENT ON COLUMN pages.server_keys.key_hash IS 'encode(sha256(convert_to(key, ''UTF8'')), ''hex'').';

-- ── Functions ──────────────────────────────────────────────────────────────

COMMENT ON FUNCTION pages.match_routes(text, text) IS 'Bot gate (block_bots) + domain rules + filter + fallback, in priority order. Matches the PATH only; `conditions` (bot gate, rules and filter) are evaluated by the serving layer. Order: bot gate (BLOCK 403 for bots only) → manual rules → filter (passed → filter_pass_page) → fallback (filter_fail_page or default_page). conditions also accepts countries_mode/languages/languages_mode; the first whose conditions pass wins; SERVE with slug_id NULL → 404.';
COMMENT ON FUNCTION pages.resolve(text, text, text) IS 'Routes from match_routes(host, path) + slug content, in one call. Requires a key from pages.server_keys. Called by the delivery server via POST /rest/v1/rpc/resolve with Content-Profile: pages.';
