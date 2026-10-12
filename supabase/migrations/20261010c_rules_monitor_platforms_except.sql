-- Rules: Monitor mode, the platform scope, exceptions and the browser-zoom signal.
--
--   is_monitor  an ACTIVE rule in Monitor runs on every click and is recorded in
--               the hit's rule_matches (with "monitor": true), but never blocks:
--               the click goes on as if the rule didn't exist. Active = is_active
--               and not is_monitor; Paused = not is_active.
--   sub11_in    conditions key: the click's sub11 (any case) is one of these
--               lowercase platform names. Replaces a rule per platform.
--   except      conditions key: 1–10 condition objects; the rule matches when all
--               its conditions match and NO exception does.
--   zoomed      conditions key (device signal): 1 = the desktop browser's zoom
--               isn't 100% (the checkpoint's outerWidth / innerWidth).
--
-- The gate data (resolve) carries each rule's id, keeps monitor rules out of
-- `rules` and `eval_rules` (an old server never sees them) and lists them in
-- `monitor_rules`. Everything else in resolve is as live (dayone-main's
-- 20261006q `default_funnel` included).
--
-- rule_save gains p_is_monitor (NULL = keep) and p_full: dayone-main's traffic
-- rules dialog calls it with the 7 old arguments and a form that doesn't know
-- the new keys — on an update without p_full the old sub11_in / except /
-- zoomed are carried over instead of being dropped.

ALTER TABLE pages.rules ADD COLUMN IF NOT EXISTS is_monitor boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN pages.rules.is_monitor IS
  'Monitor mode: the active rule is evaluated and recorded in pages.hits.rule_matches ("monitor": true) but never blocks.';

-- ── Conditions validation (one object; the trigger and each exception) ───────

CREATE OR REPLACE FUNCTION pages.rule_conditions_check(p_c jsonb, p_at text, p_nested boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  k text;
  t record;
  i int := 0;
  bit_keys text[] := array[
    'touch', 'mobile_hint', 'webdriver', 'automation', 'gl_software', 'iframe',
    'tostring_tampered', 'proto_poisoned', 'no_touch', 'chrome_ua', 'no_chrome_object',
    'tz_mismatch', 'tz_not_us', 'no_js', 'no_cookie', 'odd_resolution', 'zoomed'
  ];
BEGIN
  IF coalesce(jsonb_typeof(p_c), '') <> 'object' THEN
    RAISE EXCEPTION '% must be an object', p_at USING ERRCODE = 'check_violation';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_c) LOOP
    IF k NOT IN ('sub1', 'sub11', 'sub11_in', 'param', 'countries', 'countries_mode', 'devices', 'languages', 'languages_mode', 'query', 'referrer', 'referrer_absent',
                 'user_agent', 'user_agent_mode', 'prefetch', 'ips', 'ips_mode', 'asns', 'asns_mode', 'hostname', 'hostname_mode',
                 'accept_languages', 'except',
                 'eval_cookie', 'touch', 'mobile_hint', 'pointer', 'webdriver', 'automation', 'gl_software', 'platform',
                 'iframe', 'tostring_tampered', 'proto_poisoned', 'tz_offset', 'net_rtt_min', 'screens',
                 'nav_ttfb_above', 'coast', 'device_memory', 'plugins', 'chrome_below', 'nav_connect_min',
                 'no_touch', 'chrome_ua', 'no_chrome_object', 'tz_mismatch', 'tz_not_us', 'no_js', 'no_cookie', 'odd_resolution', 'zoomed') THEN
      RAISE EXCEPTION '%: unknown key %', p_at, k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF p_c ? 'sub1' AND p_c ->> 'sub1' !~ '^.{1,200}$' THEN
    RAISE EXCEPTION '%: invalid sub1', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'sub11' AND p_c ->> 'sub11' !~ '^.{1,200}$' THEN
    RAISE EXCEPTION '%: invalid sub11', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'sub11_in' THEN
    IF coalesce(jsonb_typeof(p_c -> 'sub11_in'), '') <> 'array' OR jsonb_array_length(p_c -> 'sub11_in') NOT BETWEEN 1 AND 20 THEN
      RAISE EXCEPTION '%: sub11_in must be a list of 1 to 20 platforms', p_at USING ERRCODE = 'check_violation';
    END IF;
    FOR t IN SELECT value FROM jsonb_array_elements(p_c -> 'sub11_in') LOOP
      IF jsonb_typeof(t.value) <> 'string' OR t.value #>> '{}' <> lower(btrim(t.value #>> '{}'))
         OR length(t.value #>> '{}') NOT BETWEEN 1 AND 40 OR t.value #>> '{}' ~ '[&=]' THEN
        RAISE EXCEPTION '%: invalid platform % (lowercase, 1–40 characters)', p_at, t.value USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  IF p_c ? 'param' THEN
    IF coalesce(jsonb_typeof(p_c -> 'param'), '') <> 'object'
       OR coalesce(p_c -> 'param' ->> 'name', '') !~ '^[A-Za-z0-9._~-]{1,100}$' THEN
      RAISE EXCEPTION '%: param needs a name', p_at USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_c -> 'param') AS kk WHERE kk IN ('equals', 'contains', 'present', 'not_equals', 'absent_or_equals')) <> 1 THEN
      RAISE EXCEPTION '%: param needs exactly one of equals, contains, present, not_equals or absent_or_equals', p_at USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_c ? 'user_agent' THEN
    IF coalesce(jsonb_typeof(p_c -> 'user_agent'), '') <> 'string'
       OR length(p_c ->> 'user_agent') NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION '%: invalid user_agent regex', p_at USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      PERFORM '' ~ (p_c ->> 'user_agent');
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '%: user_agent is not a valid regex', p_at USING ERRCODE = 'check_violation';
    END;
  END IF;

  IF p_c ? 'prefetch' AND p_c -> 'prefetch' <> 'true'::jsonb THEN
    RAISE EXCEPTION '%: prefetch can only be true', p_at USING ERRCODE = 'check_violation';
  END IF;

  IF p_c ? 'referrer_absent' AND p_c -> 'referrer_absent' <> 'true'::jsonb THEN
    RAISE EXCEPTION '%: referrer_absent can only be true', p_at USING ERRCODE = 'check_violation';
  END IF;

  IF p_c ? 'accept_languages' THEN
    IF coalesce(jsonb_typeof(p_c -> 'accept_languages'), '') <> 'object'
       OR NOT (p_c -> 'accept_languages' ?| array['min', 'max']) THEN
      RAISE EXCEPTION '%: accept_languages needs a min and/or a max', p_at USING ERRCODE = 'check_violation';
    END IF;
    FOR k IN SELECT jsonb_object_keys(p_c -> 'accept_languages') LOOP
      IF k NOT IN ('min', 'max')
         OR jsonb_typeof(p_c -> 'accept_languages' -> k) <> 'number'
         OR (p_c -> 'accept_languages' ->> k)::numeric NOT BETWEEN 0 AND 50 THEN
        RAISE EXCEPTION '%: accept_languages.% must be a number 0–50', p_at, k USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  IF p_c ? 'eval_cookie' AND p_c ->> 'eval_cookie' <> 'absent' THEN
    RAISE EXCEPTION '%: eval_cookie can only be "absent"', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'pointer' AND p_c ->> 'pointer' NOT IN ('coarse', 'fine', 'none') THEN
    RAISE EXCEPTION '%: pointer must be coarse, fine or none', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'platform' AND (coalesce(jsonb_typeof(p_c -> 'platform'), '') <> 'string' OR length(p_c ->> 'platform') NOT BETWEEN 1 AND 60) THEN
    RAISE EXCEPTION '%: invalid platform', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'tz_offset' AND (jsonb_typeof(p_c -> 'tz_offset') <> 'number' OR (p_c ->> 'tz_offset')::numeric NOT BETWEEN -840 AND 840) THEN
    RAISE EXCEPTION '%: tz_offset must be minutes, -840..840', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'net_rtt_min' AND (jsonb_typeof(p_c -> 'net_rtt_min') <> 'number'
     OR (p_c ->> 'net_rtt_min')::numeric <> trunc((p_c ->> 'net_rtt_min')::numeric)
     OR (p_c ->> 'net_rtt_min')::numeric NOT BETWEEN 1 AND 10000) THEN
    RAISE EXCEPTION '%: net_rtt_min must be whole milliseconds, 1..10000', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'nav_ttfb_above' AND (jsonb_typeof(p_c -> 'nav_ttfb_above') <> 'number'
     OR (p_c ->> 'nav_ttfb_above')::numeric <> trunc((p_c ->> 'nav_ttfb_above')::numeric)
     OR (p_c ->> 'nav_ttfb_above')::numeric NOT BETWEEN 1 AND 10000) THEN
    RAISE EXCEPTION '%: nav_ttfb_above must be whole milliseconds, 1..10000', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'nav_connect_min' AND (jsonb_typeof(p_c -> 'nav_connect_min') <> 'number'
     OR (p_c ->> 'nav_connect_min')::numeric <> trunc((p_c ->> 'nav_connect_min')::numeric)
     OR (p_c ->> 'nav_connect_min')::numeric NOT BETWEEN 1 AND 10000) THEN
    RAISE EXCEPTION '%: nav_connect_min must be whole milliseconds, 1..10000', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'chrome_below' AND (jsonb_typeof(p_c -> 'chrome_below') <> 'number'
     OR (p_c ->> 'chrome_below')::numeric <> trunc((p_c ->> 'chrome_below')::numeric)
     OR (p_c ->> 'chrome_below')::numeric NOT BETWEEN 1 AND 1000) THEN
    RAISE EXCEPTION '%: chrome_below must be a whole Chrome major version, 1..1000', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'device_memory' AND (jsonb_typeof(p_c -> 'device_memory') <> 'number'
     OR (p_c ->> 'device_memory')::numeric <> trunc((p_c ->> 'device_memory')::numeric)
     OR (p_c ->> 'device_memory')::numeric NOT BETWEEN 1 AND 1024) THEN
    RAISE EXCEPTION '%: device_memory must be whole GB, 1..1024', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'plugins' AND (jsonb_typeof(p_c -> 'plugins') <> 'number'
     OR (p_c ->> 'plugins')::numeric <> trunc((p_c ->> 'plugins')::numeric)
     OR (p_c ->> 'plugins')::numeric NOT BETWEEN 0 AND 1000) THEN
    RAISE EXCEPTION '%: plugins must be a whole count, 0..1000', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'coast' AND p_c ->> 'coast' NOT IN ('east', 'west') THEN
    RAISE EXCEPTION '%: coast must be east or west', p_at USING ERRCODE = 'check_violation';
  END IF;
  IF p_c ? 'screens' THEN
    IF coalesce(jsonb_typeof(p_c -> 'screens'), '') <> 'array' OR jsonb_array_length(p_c -> 'screens') NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION '%: screens must be a list of 1 to 50 sizes (WxH)', p_at USING ERRCODE = 'check_violation';
    END IF;
    FOR t IN SELECT value FROM jsonb_array_elements(p_c -> 'screens') LOOP
      IF jsonb_typeof(t.value) <> 'string' OR t.value #>> '{}' !~ '^[0-9]{2,5}x[0-9]{2,5}$' THEN
        RAISE EXCEPTION '%: invalid screen size % (WxH, e.g. 800x600)', p_at, t.value USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  FOREACH k IN ARRAY bit_keys LOOP
    IF p_c ? k AND p_c -> k NOT IN ('0'::jsonb, '1'::jsonb) THEN
      RAISE EXCEPTION '%: % must be 0 or 1', p_at, k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF p_c ? 'ips' THEN
    IF coalesce(jsonb_typeof(p_c -> 'ips'), '') <> 'array' OR jsonb_array_length(p_c -> 'ips') NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION '%: ips must be a list of 1 to 200 IPs or ranges', p_at USING ERRCODE = 'check_violation';
    END IF;
    FOR t IN SELECT value FROM jsonb_array_elements_text(p_c -> 'ips') LOOP
      BEGIN
        PERFORM t.value::inet;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION '%: invalid IP or range %', p_at, t.value USING ERRCODE = 'check_violation';
      END;
    END LOOP;
  END IF;
  IF p_c ? 'asns' THEN
    IF coalesce(jsonb_typeof(p_c -> 'asns'), '') <> 'array' OR jsonb_array_length(p_c -> 'asns') NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION '%: asns must be a list of 1 to 200 AS numbers', p_at USING ERRCODE = 'check_violation';
    END IF;
    FOR t IN SELECT value FROM jsonb_array_elements(p_c -> 'asns') LOOP
      IF jsonb_typeof(t.value) <> 'number' OR (t.value)::numeric <> trunc((t.value)::numeric) OR (t.value)::numeric NOT BETWEEN 1 AND 4294967295 THEN
        RAISE EXCEPTION '%: invalid AS number %', p_at, t.value USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  IF p_c ? 'hostname' THEN
    IF coalesce(jsonb_typeof(p_c -> 'hostname'), '') <> 'string'
       OR length(p_c ->> 'hostname') NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION '%: invalid hostname regex', p_at USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      PERFORM '' ~ (p_c ->> 'hostname');
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '%: hostname is not a valid regex', p_at USING ERRCODE = 'check_violation';
    END;
  END IF;
  IF (p_c ? 'ips_mode' AND (p_c ->> 'ips_mode' <> 'block' OR NOT p_c ? 'ips'))
     OR (p_c ? 'asns_mode' AND (p_c ->> 'asns_mode' <> 'block' OR NOT p_c ? 'asns'))
     OR (p_c ? 'hostname_mode' AND (p_c ->> 'hostname_mode' <> 'block' OR NOT p_c ? 'hostname')) THEN
    RAISE EXCEPTION '%: a mode needs its list and can only be "block"', p_at USING ERRCODE = 'check_violation';
  END IF;

  -- Exceptions: each one a non-empty condition object of its own, one level only.
  IF p_c ? 'except' THEN
    IF p_nested THEN
      RAISE EXCEPTION '%: an exception can''t have exceptions', p_at USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(jsonb_typeof(p_c -> 'except'), '') <> 'array' OR jsonb_array_length(p_c -> 'except') NOT BETWEEN 1 AND 10 THEN
      RAISE EXCEPTION '%: except must be a list of 1 to 10 exceptions', p_at USING ERRCODE = 'check_violation';
    END IF;
    FOR t IN SELECT value FROM jsonb_array_elements(p_c -> 'except') LOOP
      i := i + 1;
      IF jsonb_typeof(t.value) <> 'object' OR t.value = '{}'::jsonb THEN
        RAISE EXCEPTION '%: exception % is empty', p_at, i USING ERRCODE = 'check_violation';
      END IF;
      PERFORM pages.rule_conditions_check(t.value, format('%s: exception %s', p_at, i), true);
    END LOOP;
  END IF;
END $function$;

REVOKE ALL ON FUNCTION pages.rule_conditions_check(jsonb, text, boolean) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION pages.rules_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
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
  PERFORM pages.rule_conditions_check(NEW.conditions, 'rules.conditions');
  RETURN NEW;
END $function$;

-- ── rule_save: Monitor, and a legacy caller can't drop what it doesn't know ──

DROP FUNCTION IF EXISTS pages.rule_save(uuid, text, text, jsonb, jsonb, boolean, text);

CREATE FUNCTION pages.rule_save(
  p_id uuid, p_name text, p_label text, p_tags jsonb, p_conditions jsonb, p_is_active boolean,
  p_reason text DEFAULT '', p_is_monitor boolean DEFAULT NULL, p_full boolean DEFAULT false
)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_old jsonb;
  v_cond jsonb := coalesce(p_conditions, '{}'::jsonb);
  k text;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO pages.rules (name, label, tags, conditions, is_active, is_monitor, reason, position)
    VALUES (btrim(p_name), btrim(p_label), coalesce(p_tags, '[]'::jsonb), v_cond, coalesce(p_is_active, true),
            coalesce(p_is_monitor, false), btrim(coalesce(p_reason, '')),
            (SELECT coalesce(max(x.position), 0) + 1 FROM pages.rules x))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  SELECT r.conditions INTO v_old FROM pages.rules r WHERE r.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rule_save: rule not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- A caller that doesn't know the newer keys (p_full false) keeps them as they were.
  IF NOT coalesce(p_full, false) THEN
    FOREACH k IN ARRAY array['sub11_in', 'except', 'zoomed'] LOOP
      IF v_old ? k AND NOT v_cond ? k THEN
        v_cond := v_cond || jsonb_build_object(k, v_old -> k);
      END IF;
    END LOOP;
  END IF;

  UPDATE pages.rules r
  SET name = btrim(p_name),
      label = btrim(p_label),
      tags = coalesce(p_tags, '[]'::jsonb),
      conditions = v_cond,
      is_active = coalesce(p_is_active, true),
      is_monitor = coalesce(p_is_monitor, r.is_monitor),
      reason = btrim(coalesce(p_reason, ''))
  WHERE r.id = p_id
  RETURNING r.id INTO v_id;
  RETURN v_id;
END $function$;

REVOKE ALL ON FUNCTION pages.rule_save(uuid, text, text, jsonb, jsonb, boolean, text, boolean, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rule_save(uuid, text, text, jsonb, jsonb, boolean, text, boolean, boolean) TO service_role;

-- ── rules_list: the mode and when the rule was created (for the spike baseline) ──

DROP FUNCTION IF EXISTS pages.rules_list();

CREATE FUNCTION pages.rules_list()
 RETURNS TABLE(id uuid, name text, label text, tags jsonb, conditions jsonb, "position" integer, is_active boolean, reason text, is_monitor boolean, created_at timestamptz)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT r.id, r.name, r.label, r.tags, r.conditions, r.position, r.is_active, r.reason, r.is_monitor, r.created_at
  FROM pages.rules r
  ORDER BY r.position, r.created_at;
$function$;

REVOKE ALL ON FUNCTION pages.rules_list() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rules_list() TO service_role;

-- ── resolve: rule ids, monitor rules apart ───────────────────────────────────

CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
 RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb, action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text, status_code smallint, preserve_query boolean, content text, placeholders jsonb, gate jsonb, vsl jsonb)
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
             -- The domain's default funnel in UNLOCKED (dayone-main's dashboard sets it when it unlocks the domain): a click without [F…].
             'default_funnel', nullif(upper(btrim(coalesce(d.settings ->> 'default_funnel', ''))), ''),
             -- The rules that block: active and not in Monitor.
             'rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', r.id, 'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active AND NOT r.is_monitor
             ), '[]'::jsonb),
             -- The device checkpoint's rules (server/src/eval.php): the active
             -- Suspicious ones. Present and non-empty = the checkpoint is on.
             'eval_rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', r.id, 'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active AND NOT r.is_monitor AND lower(r.label) = 'suspicious'
             ), '[]'::jsonb),
             -- Monitor mode: evaluated and recorded in the hit's rule_matches, never blocks (rules.php gate_rules_matched).
             'monitor_rules', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', r.id, 'name', r.name, 'label', r.label, 'reason', r.reason, 'tags', r.tags, 'conditions', r.conditions
                      ) ORDER BY r.position, r.created_at)
               FROM pages.rules r WHERE r.is_active AND r.is_monitor
             ), '[]'::jsonb),
             'funnels', coalesce((
               SELECT jsonb_object_agg(upper(f.code), jsonb_build_object(
                 -- The funnel's name: the UNLOCKED domain's funnel picker lists it next to the code.
                 'name', f.name,
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
           ) AS gate,
           vs.vsl
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id
    LEFT JOIN LATERAL (
      SELECT coalesce(rp.funnel_id, (
               SELECT fx.id FROM pages.funnels fx WHERE fx.site ? rp.id::text
               ORDER BY (fx.code IS NULL OR btrim(fx.code) = '') DESC, fx.created_at LIMIT 1)) AS funnel_id
      FROM pages.pages rp
      WHERE m.slug_id IS NOT NULL AND rp.id = m.page_id
    ) fp ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', x.key, 'weight', (x.value ->> 'weight')::numeric) ORDER BY x.key) AS vsl
      FROM pages.funnels fu
      CROSS JOIN LATERAL jsonb_each(fu.vsl) x
      WHERE fp.funnel_id IS NOT NULL AND fu.id = fp.funnel_id AND coalesce((x.value ->> 'weight')::numeric, 0) > 0
    ) vs ON true;
END
$function$;
