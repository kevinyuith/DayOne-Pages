-- A rule condition for traffic with no referrer at all: referrer_absent = true
-- matches when the Referer header is empty. Request-side (conditions.php /
-- conditions_match), so it belongs to Bot rules — e.g. Taboola clicks must
-- carry a referrer; one that arrives without any is flagged.
--
-- Only rules_check changes: allow the key and let it be `true` only (like
-- `prefetch`). The server (server/src/conditions.php) and the dashboard
-- (src/lib/pages/conditions.ts) carry the matching logic and form.

CREATE OR REPLACE FUNCTION pages.rules_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  k text;
  t record;
  bit_keys text[] := array[
    'touch', 'mobile_hint', 'webdriver', 'automation', 'gl_software', 'iframe',
    'tostring_tampered', 'proto_poisoned', 'no_touch', 'chrome_ua', 'no_chrome_object',
    'tz_mismatch', 'no_js', 'no_cookie', 'odd_resolution'
  ];
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
    IF k NOT IN ('sub1', 'sub11', 'param', 'countries', 'countries_mode', 'devices', 'languages', 'languages_mode', 'query', 'referrer', 'referrer_absent',
                 'user_agent', 'user_agent_mode', 'prefetch', 'ips', 'ips_mode', 'asns', 'asns_mode', 'hostname', 'hostname_mode',
                 'accept_languages',
                 'eval_cookie', 'touch', 'mobile_hint', 'pointer', 'webdriver', 'automation', 'gl_software', 'platform',
                 'iframe', 'tostring_tampered', 'proto_poisoned', 'tz_offset',
                 'no_touch', 'chrome_ua', 'no_chrome_object', 'tz_mismatch', 'no_js', 'no_cookie', 'odd_resolution') THEN
      RAISE EXCEPTION 'rules.conditions: unknown key %', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW.conditions ? 'sub1' AND NEW.conditions ->> 'sub1' !~ '^.{1,200}$' THEN
    RAISE EXCEPTION 'rules.conditions: invalid sub1' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.conditions ? 'sub11' AND NEW.conditions ->> 'sub11' !~ '^.{1,200}$' THEN
    RAISE EXCEPTION 'rules.conditions: invalid sub11' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.conditions ? 'param' THEN
    IF coalesce(jsonb_typeof(NEW.conditions -> 'param'), '') <> 'object'
       OR coalesce(NEW.conditions -> 'param' ->> 'name', '') !~ '^[A-Za-z0-9._~-]{1,100}$' THEN
      RAISE EXCEPTION 'rules.conditions: param needs a name' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.conditions -> 'param') AS kk WHERE kk IN ('equals', 'contains', 'present', 'not_equals', 'absent_or_equals')) <> 1 THEN
      RAISE EXCEPTION 'rules.conditions: param needs exactly one of equals, contains, present, not_equals or absent_or_equals' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
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

  IF NEW.conditions ? 'prefetch' AND NEW.conditions -> 'prefetch' <> 'true'::jsonb THEN
    RAISE EXCEPTION 'rules.conditions: prefetch can only be true' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.conditions ? 'referrer_absent' AND NEW.conditions -> 'referrer_absent' <> 'true'::jsonb THEN
    RAISE EXCEPTION 'rules.conditions: referrer_absent can only be true' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.conditions ? 'accept_languages' THEN
    IF coalesce(jsonb_typeof(NEW.conditions -> 'accept_languages'), '') <> 'object'
       OR NOT (NEW.conditions -> 'accept_languages' ?| array['min', 'max']) THEN
      RAISE EXCEPTION 'rules.conditions: accept_languages needs a min and/or a max' USING ERRCODE = 'check_violation';
    END IF;
    FOR k IN SELECT jsonb_object_keys(NEW.conditions -> 'accept_languages') LOOP
      IF k NOT IN ('min', 'max')
         OR jsonb_typeof(NEW.conditions -> 'accept_languages' -> k) <> 'number'
         OR (NEW.conditions -> 'accept_languages' ->> k)::numeric NOT BETWEEN 0 AND 50 THEN
        RAISE EXCEPTION 'rules.conditions: accept_languages.% must be a number 0–50', k USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  IF NEW.conditions ? 'eval_cookie' AND NEW.conditions ->> 'eval_cookie' <> 'absent' THEN
    RAISE EXCEPTION 'rules.conditions: eval_cookie can only be "absent"' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.conditions ? 'pointer' AND NEW.conditions ->> 'pointer' NOT IN ('coarse', 'fine', 'none') THEN
    RAISE EXCEPTION 'rules.conditions: pointer must be coarse, fine or none' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.conditions ? 'platform' AND (coalesce(jsonb_typeof(NEW.conditions -> 'platform'), '') <> 'string' OR length(NEW.conditions ->> 'platform') NOT BETWEEN 1 AND 60) THEN
    RAISE EXCEPTION 'rules.conditions: invalid platform' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.conditions ? 'tz_offset' AND (jsonb_typeof(NEW.conditions -> 'tz_offset') <> 'number' OR (NEW.conditions ->> 'tz_offset')::numeric NOT BETWEEN -840 AND 840) THEN
    RAISE EXCEPTION 'rules.conditions: tz_offset must be minutes, -840..840' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH k IN ARRAY bit_keys LOOP
    IF NEW.conditions ? k AND NEW.conditions -> k NOT IN ('0'::jsonb, '1'::jsonb) THEN
      RAISE EXCEPTION 'rules.conditions: % must be 0 or 1', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF NEW.conditions ? 'ips' THEN
    IF coalesce(jsonb_typeof(NEW.conditions -> 'ips'), '') <> 'array' OR jsonb_array_length(NEW.conditions -> 'ips') NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'rules.conditions: ips must be a list of 1 to 200 IPs or ranges' USING ERRCODE = 'check_violation';
    END IF;
    FOR t IN SELECT value FROM jsonb_array_elements_text(NEW.conditions -> 'ips') LOOP
      BEGIN
        PERFORM t.value::inet;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'rules.conditions: invalid IP or range %', t.value USING ERRCODE = 'check_violation';
      END;
    END LOOP;
  END IF;
  IF NEW.conditions ? 'asns' THEN
    IF coalesce(jsonb_typeof(NEW.conditions -> 'asns'), '') <> 'array' OR jsonb_array_length(NEW.conditions -> 'asns') NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'rules.conditions: asns must be a list of 1 to 200 AS numbers' USING ERRCODE = 'check_violation';
    END IF;
    FOR t IN SELECT value FROM jsonb_array_elements(NEW.conditions -> 'asns') LOOP
      IF jsonb_typeof(t.value) <> 'number' OR (t.value)::numeric <> trunc((t.value)::numeric) OR (t.value)::numeric NOT BETWEEN 1 AND 4294967295 THEN
        RAISE EXCEPTION 'rules.conditions: invalid AS number %', t.value USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  IF NEW.conditions ? 'hostname' THEN
    IF coalesce(jsonb_typeof(NEW.conditions -> 'hostname'), '') <> 'string'
       OR length(NEW.conditions ->> 'hostname') NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'rules.conditions: invalid hostname regex' USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      PERFORM '' ~ (NEW.conditions ->> 'hostname');
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'rules.conditions: hostname is not a valid regex' USING ERRCODE = 'check_violation';
    END;
  END IF;
  IF (NEW.conditions ? 'ips_mode' AND (NEW.conditions ->> 'ips_mode' <> 'block' OR NOT NEW.conditions ? 'ips'))
     OR (NEW.conditions ? 'asns_mode' AND (NEW.conditions ->> 'asns_mode' <> 'block' OR NOT NEW.conditions ? 'asns'))
     OR (NEW.conditions ? 'hostname_mode' AND (NEW.conditions ->> 'hostname_mode' <> 'block' OR NOT NEW.conditions ? 'hostname')) THEN
    RAISE EXCEPTION 'rules.conditions: a mode needs its list and can only be "block"' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;
