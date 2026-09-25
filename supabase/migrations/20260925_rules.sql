-- ============================================================================
-- DayOne Pages — the traffic gate (rules), on every path
--
-- A domain stops having a filter, a bot block and a default page: it IS its
-- pages and their slugs, and every request goes through the traffic gate. The
-- rules DETECT bad traffic; they don't route it. The delivery server walks the
-- active rules IN ORDER (position): the first one whose conditions all match
-- marks the click with the rule's LABEL (Bot, Suspicious — free text) and it
-- gets the domain's page AT THE REQUESTED SLUG (404 when no page has it). A
-- click that matches NO rule is clean; on an allowed slug ("/" or one of the
-- domain's gate_slugs) it goes to the funnel named in its sub1's [F…] token
-- ([F23] → pages.funnels.code F23), whose A/B test (weights live in
-- pages.funnels.site) picks the page, sticky in dop_pg. Any other slug, or no
-- token → the domain's page at that slug (404).
--
--   The conditions are the hit log's fields, every one optional: the click's
--   sub ids (sub1, sub11, exact), ANY URL parameter (param: name + equals /
--   contains / present), country, device, languages (+ allow/block), referrer
--   (contains) and a regular expression on the User-Agent. `{}` matches
--   everyone — with no rules at all, every click is clean. Nothing is detected
--   in code: a bot is only a bot because a rule says so.
--
--   pages.domains.gate_slugs   the slugs where a clean click goes to the funnel
--   pages.rules                one row per rule, ordered by `position`
--   pages.rule_save / _delete  write functions (no direct table writes)
--   pages.rule_move            reorders (position = the walk order)
--   pages.resolve              REWRITTEN: the domain's pages at the requested
--                              slug + the gate's data fused in a `gate` column
--                              (rules + gate_slugs + every funnel's live split
--                              and VSL) — one call, no separate rules_data.
--   pages.hits.rule_label / rule / rule_tags   the detection (tracker data):
--                     the label, the rule's name and its tags when one matched;
--                     pages.hits.funnel — the funnel code the clean click went to.
--
-- Everything in the `pages` schema, in English, in UTC. Idempotent.
-- ============================================================================

-- ── pages.domains.gate_slugs ────────────────────────────────────────────────
--
-- The slugs where a clean click may go to the funnel of its sub1. "/"
-- always is; the domain adds the others. Any other slug falls to the domain's
-- safe page at that slug (the page's HTML for the requested path; 404 when the
-- page doesn't have it).

ALTER TABLE pages.domains ADD COLUMN IF NOT EXISTS gate_slugs jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN pages.domains.gate_slugs IS 'The slugs where a clean click goes to the funnel of its sub1 (besides "/"): ["/oferta", …]. The funnel''s main page (its "/" slug) is served at every allowed slug.';

CREATE OR REPLACE FUNCTION pages.domains_gate_slugs_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  s record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.gate_slugs), '') <> 'array' THEN
    RAISE EXCEPTION 'domains.gate_slugs must be an array' USING ERRCODE = 'check_violation';
  END IF;
  FOR s IN SELECT value FROM jsonb_array_elements_text(NEW.gate_slugs) LOOP
    IF s.value !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' THEN
      RAISE EXCEPTION 'domains.gate_slugs: invalid slug %', s.value USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_domains_gate_slugs_check ON pages.domains;
CREATE TRIGGER trg_pages_domains_gate_slugs_check BEFORE INSERT OR UPDATE OF gate_slugs ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.domains_gate_slugs_check();

-- ── The domain loses the filter, the bot block and the default page ─────────
--
-- The gate (pages.rules) decides everything now: a domain is its pages and
-- their slugs. The old default page becomes just a page of the domain (it
-- stays in domains.site), served at whatever slug the visitor asked for.
--
-- domains.site no longer validates default/filter pages (they don't exist);
-- it only checks that every entry is a page of this domain, owned by no other.

-- The trigger keeps a dependency on the dropped columns, so it goes first.
DROP TRIGGER IF EXISTS trg_pages_domains_site_check ON pages.domains;

CREATE OR REPLACE FUNCTION pages.domains_site_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  pg record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.site), '') <> 'object' THEN
    RAISE EXCEPTION 'domains.site must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR pg IN SELECT key, value FROM jsonb_each(NEW.site) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object' THEN
      RAISE EXCEPTION 'domains.site: invalid entry %', pg.key USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pages.pages p WHERE p.id = pg.key::uuid AND p.scope = 'DOMAIN') THEN
      RAISE EXCEPTION 'domains.site: % is not a domain page', pg.key USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM pages.domains o WHERE o.id <> NEW.id AND o.site ? pg.key) THEN
      RAISE EXCEPTION 'domains.site: page % belongs to another domain', pg.key USING ERRCODE = 'unique_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

ALTER TABLE pages.domains
  DROP COLUMN IF EXISTS default_page_id,
  DROP COLUMN IF EXISTS filter_pass_page_id,
  DROP COLUMN IF EXISTS filter_fail_page_id,
  DROP COLUMN IF EXISTS filter,
  DROP COLUMN IF EXISTS block_bots;

CREATE TRIGGER trg_pages_domains_site_check BEFORE INSERT OR UPDATE OF site ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.domains_site_check();

-- ── match_routes: the domain's pages, each with the requested slug ──────────
--
-- What a domain serves at a path: its pages, with the requested path as the
-- slug (the HTML the visitor sees is the one of that slug). No filter, no bot
-- block, no default — the gate (rules.php) decides which page and whether the
-- funnel takes over. A page without that slug simply doesn't come back (the
-- server answers 404).
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
    WHERE d.status = 'ACTIVE' AND d.domain = req.host
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

-- Adds a page to the domain's list (no default page any more: every page of
-- the domain is served at its slugs).
CREATE OR REPLACE FUNCTION pages.domain_list_page(p_domain uuid, p_page uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE pages.domains d
  SET site = d.site || jsonb_build_object(p_page::text, '{}'::jsonb)
  WHERE d.id = p_domain;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain not found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- ── pages.rules ─────────────────────────────────────────────────────────────
--
-- An earlier take on the rules had action + funnel_id (the rule routed the
-- click). The final model DETECTS (a label) and the funnel comes from the
-- sub1, so the table is recreated (it was never used with traffic).

DROP TABLE IF EXISTS pages.rules CASCADE;

CREATE TABLE pages.rules (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  label       text        NOT NULL,
  tags        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  conditions  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  position    int         NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_rules_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT ck_rules_label_len CHECK (length(btrim(label)) BETWEEN 1 AND 60)
);

COMMENT ON TABLE pages.rules IS 'The traffic rules of the gate on /: they DETECT bad traffic. Walked in order (position); the first whose conditions all match marks the click with the rule''s label and it gets the domain''s safe page. A clean click goes to the funnel of its sub1 ([F…] token).';
COMMENT ON COLUMN pages.rules.name IS 'The rule''s own name (e.g. "Datacenter US"), recorded in hits.rule so you can see WHERE the click was caught.';
COMMENT ON COLUMN pages.rules.label IS 'The category recorded in hits.rule_label when the rule matches (Bot, Suspicious… — free text).';
COMMENT ON COLUMN pages.rules.tags IS 'Free labels to group (["Facebook"], ["TikTok"]): ["tag", …], up to 10, each up to 40 chars. Recorded in hits.rule_tags.';
COMMENT ON COLUMN pages.rules.conditions IS 'The hit log''s fields, every one optional: sub1, sub11 (exact), param ({name, equals|contains|present}), countries, devices, languages (+ allow/block modes), referrer (contains), query (params), user_agent (a regex). {} = everyone.';
COMMENT ON COLUMN pages.rules.position IS 'The walk order: lowest first; the first match decides.';

CREATE INDEX IF NOT EXISTS idx_pages_rules_walk ON pages.rules (is_active, position, created_at);

ALTER TABLE pages.rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.rules FROM public, anon, authenticated;
GRANT SELECT ON pages.rules TO service_role;

DROP TRIGGER IF EXISTS trg_pages_rules_updated_at ON pages.rules;
CREATE TRIGGER trg_pages_rules_updated_at BEFORE UPDATE ON pages.rules
  FOR EACH ROW EXECUTE FUNCTION pages.set_updated_at();

-- Shape checks, so no rule the server can't evaluate is ever saved.
CREATE OR REPLACE FUNCTION pages.rules_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  k text;
  t record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.tags), '') <> 'array' OR jsonb_array_length(NEW.tags) > 10 THEN
    RAISE EXCEPTION 'rules.tags must be an array of up to 10 tags' USING ERRCODE = 'check_violation';
  END IF;
  FOR t IN SELECT value FROM jsonb_array_elements_text(NEW.tags) LOOP
    IF length(btrim(t.value)) NOT BETWEEN 1 AND 40 THEN
      RAISE EXCEPTION 'rules.tags: invalid tag %', t.value USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF coalesce(jsonb_typeof(NEW.conditions), '') <> 'object' THEN
    RAISE EXCEPTION 'rules.conditions must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR k IN SELECT jsonb_object_keys(NEW.conditions) LOOP
    IF k NOT IN ('sub1', 'sub11', 'param', 'countries', 'countries_mode', 'devices', 'languages', 'languages_mode', 'query', 'referrer', 'user_agent', 'user_agent_mode') THEN
      RAISE EXCEPTION 'rules.conditions: unknown key %', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  -- The exact sub ids.
  IF NEW.conditions ? 'sub1' AND NEW.conditions ->> 'sub1' !~ '^.{1,200}$' THEN
    RAISE EXCEPTION 'rules.conditions: invalid sub1' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.conditions ? 'sub11' AND NEW.conditions ->> 'sub11' !~ '^.{1,200}$' THEN
    RAISE EXCEPTION 'rules.conditions: invalid sub11' USING ERRCODE = 'check_violation';
  END IF;
  -- The generic parameter: { "name": <param>, one of equals|contains|present }.
  IF NEW.conditions ? 'param' THEN
    IF coalesce(jsonb_typeof(NEW.conditions -> 'param'), '') <> 'object'
       OR coalesce(NEW.conditions -> 'param' ->> 'name', '') !~ '^[A-Za-z0-9._~-]{1,100}$' THEN
      RAISE EXCEPTION 'rules.conditions: param needs a name' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.conditions -> 'param') AS kk WHERE kk IN ('equals', 'contains', 'present')) <> 1 THEN
      RAISE EXCEPTION 'rules.conditions: param needs exactly one of equals, contains or present' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The user-agent regex must compile (the server runs it per click).
  IF NEW.conditions ? 'user_agent' THEN
    IF coalesce(jsonb_typeof(NEW.conditions -> 'user_agent'), '') <> 'string'
       OR length(NEW.conditions ->> 'user_agent') NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'rules.conditions: invalid user_agent regex' USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      PERFORM '' ~ (NEW.conditions ->> 'user_agent');
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'rules.conditions: user_agent is not a valid regex' USING ERRCODE = 'check_violation';
    END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_rules_check ON pages.rules;
CREATE TRIGGER trg_pages_rules_check BEFORE INSERT OR UPDATE OF tags, conditions ON pages.rules
  FOR EACH ROW EXECUTE FUNCTION pages.rules_check();

-- ── Write functions ─────────────────────────────────────────────────────────
--
-- The earlier take's functions have different signatures/return types, so
-- they go first (the table above them was already dropped with CASCADE).

DROP FUNCTION IF EXISTS pages.rule_save(uuid, text, jsonb, jsonb, text, uuid, boolean);
DROP FUNCTION IF EXISTS pages.rule_move(uuid, int);
DROP FUNCTION IF EXISTS pages.rules_list();

-- Create or update a rule (p_id NULL = create, appended at the end).
CREATE OR REPLACE FUNCTION pages.rule_save(
  p_id         uuid,
  p_name       text,
  p_label      text,
  p_tags       jsonb,
  p_conditions jsonb,
  p_is_active  boolean
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO pages.rules (name, label, tags, conditions, is_active, position)
    VALUES (btrim(p_name), btrim(p_label), coalesce(p_tags, '[]'::jsonb), coalesce(p_conditions, '{}'::jsonb), coalesce(p_is_active, true),
            (SELECT coalesce(max(x.position), 0) + 1 FROM pages.rules x))
    RETURNING id INTO v_id;
  ELSE
    UPDATE pages.rules r
    SET name = btrim(p_name),
        label = btrim(p_label),
        tags = coalesce(p_tags, '[]'::jsonb),
        conditions = coalesce(p_conditions, '{}'::jsonb),
        is_active = coalesce(p_is_active, true)
    WHERE r.id = p_id
    RETURNING r.id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'rule_save: rule not found' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION pages.rule_delete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
BEGIN
  DELETE FROM pages.rules r WHERE r.id = p_id;
END $$;

-- Moves a rule one step in the walk order (p_dir: -1 up, +1 down) by swapping
-- positions with its neighbour.
CREATE OR REPLACE FUNCTION pages.rule_move(p_id uuid, p_dir int)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_pos int;
  v_other uuid;
  v_other_pos int;
BEGIN
  SELECT r.position INTO v_pos FROM pages.rules r WHERE r.id = p_id FOR UPDATE;
  IF v_pos IS NULL THEN
    RAISE EXCEPTION 'rule_move: rule not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_dir < 0 THEN
    SELECT r.id, r.position INTO v_other, v_other_pos FROM pages.rules r WHERE r.position < v_pos ORDER BY r.position DESC LIMIT 1;
  ELSE
    SELECT r.id, r.position INTO v_other, v_other_pos FROM pages.rules r WHERE r.position > v_pos ORDER BY r.position LIMIT 1;
  END IF;
  IF v_other IS NULL THEN
    RETURN;
  END IF;
  UPDATE pages.rules r SET position = -1 WHERE r.id = p_id;
  UPDATE pages.rules r SET position = v_pos WHERE r.id = v_other;
  UPDATE pages.rules r SET position = v_other_pos WHERE r.id = p_id;
END $$;

-- The list the dashboard reads, in walk order (no HTML anywhere).
CREATE OR REPLACE FUNCTION pages.rules_list()
RETURNS TABLE(id uuid, name text, label text, tags jsonb, conditions jsonb, "position" int, is_active boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT r.id, r.name, r.label, r.tags, r.conditions, r.position, r.is_active
  FROM pages.rules r
  ORDER BY r.position, r.created_at;
$$;

-- ── pages.hits: the detection + the funnel (tracker data) ───────────────────

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS rule_label text;
ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS rule text;
ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS rule_tags jsonb;
ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS funnel text;

COMMENT ON COLUMN pages.hits.rule_label IS 'The label of the traffic rule that caught the click (Bot, Suspicious…), when one matched on the gate.';
COMMENT ON COLUMN pages.hits.rule IS 'The name of the rule that caught the click (WHERE it was caught), when one matched.';
COMMENT ON COLUMN pages.hits.rule_tags IS 'The tags of the rule that caught the click (["Facebook", …]).';
COMMENT ON COLUMN pages.hits.funnel IS 'The funnel code the clean click went to (the sub1''s [F…] token, e.g. F23), when it passed every rule.';

DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text, text, text, text, text);

CREATE FUNCTION pages.log_hit(
  p_key           text,
  p_domain        uuid,
  p_host          text,
  p_path          text,
  p_outcome       text,
  p_status        int,
  p_country       text,
  p_device        text,
  p_is_bot        boolean,
  p_referrer_host text,
  p_ip            text,
  p_user_agent    text,
  p_hostname      text DEFAULT NULL,
  p_asn           int  DEFAULT NULL,
  p_as_name       text DEFAULT NULL,
  p_cookies       text DEFAULT NULL,
  p_region        text DEFAULT NULL,
  p_route_id      uuid DEFAULT NULL,
  p_page_id       uuid DEFAULT NULL,
  p_slug          text DEFAULT NULL,
  p_decision      text DEFAULT NULL,
  p_query         text DEFAULT NULL,
  p_redirect_url  text DEFAULT NULL,
  p_visit_id      text DEFAULT NULL,
  p_rule_label    text DEFAULT NULL,
  p_rule          text DEFAULT NULL,
  p_rule_tags     jsonb DEFAULT NULL,
  p_funnel        text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
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
                          rule_label, rule, rule_tags, funnel)
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
    nullif(left(coalesce(p_funnel, ''), 40), '')
  );
END $$;

-- ── pages.resolve — the decision, fused: routes + the gate ──────────────────
--
-- One call for (host, path): the domain's pages at the requested slug (the
-- routes the gate may serve — no filter/bot/default any more), each content
-- hash, the placeholders, AND the gate's data in a new `gate` column (the
-- active rules in order, the gate_slugs, and every funnel's code + live split
-- + VSL). The PHP gate (rules.php) reads `gate` once and decides per request:
-- a matched rule → the page at the requested slug; a clean click on an
-- allowed slug → the funnel of the sub1's [F…] token.
--
-- The return type changed (the `gate` column replaces the per-route split/vsl),
-- so the old one goes first.
DROP FUNCTION IF EXISTS pages.resolve(text, text, text, boolean);

CREATE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb,
              action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text,
              status_code smallint, preserve_query boolean, content text, placeholders jsonb, gate jsonb)
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
                        'name', r.name, 'label', r.label, 'tags', r.tags, 'conditions', r.conditions
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

COMMENT ON FUNCTION pages.resolve(text, text, text, boolean) IS 'The delivery server''s decision for host + path (server key required): the domain''s pages at the requested slug (routes), their content hashes (and HTML with p_with_content), the placeholders, and the gate''s data (rules, gate_slugs, funnels) in the `gate` column.';

REVOKE ALL ON FUNCTION pages.resolve(text, text, text, boolean) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text, boolean) TO anon, service_role;

-- ── content_get: the gate serves FUNNEL pages directly now ──────────────────
--
-- The gate serves a funnel's pages straight (scope FUNNEL), not only the
-- domain's copies (scope DOMAIN) — so content_get takes both.

CREATE OR REPLACE FUNCTION pages.content_get(p_refs jsonb, p_key text)
RETURNS TABLE (page_id uuid, slug text, content_hash text, content text)
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

REVOKE ALL ON FUNCTION pages.content_get(jsonb, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.content_get(jsonb, text) TO anon, service_role;

-- ── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION pages.rule_save(uuid, text, text, jsonb, jsonb, boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_delete(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_move(uuid, int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rules_list() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rule_save(uuid, text, text, jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION pages.rule_delete(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION pages.rule_move(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION pages.rules_list() TO service_role;

REVOKE ALL ON FUNCTION pages.rules_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.domains_gate_slugs_check() FROM public, anon, authenticated;

REVOKE ALL ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
