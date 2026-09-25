-- ============================================================================
-- DayOne Pages — rule conditions on the click's IP, ASN and hostname
--
-- Three more ways for a rule to identify bad traffic:
--
--   ips       IPs and CIDR ranges ("203.0.113.7", "10.0.0.0/8", "2001:db8::/32");
--             ips_mode "block" inverts (the IP is NOT in the list).
--   asns      AS numbers (16509, 15169…); asns_mode "block" inverts.
--   hostname  a case-insensitive regex on the IP's reverse DNS (PTR);
--             hostname_mode "block" inverts (doesn't match).
--
-- The delivery server looks the ASN and the hostname up only when a rule that
-- uses them is reached, with a short timeout and a per-IP cache; a lookup that
-- fails makes the condition not match (server/src/rules.php, netinfo.php).
-- This migration only widens pages.rules_check to accept and validate them.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.rules_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
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
    IF k NOT IN ('sub1', 'sub11', 'param', 'countries', 'countries_mode', 'devices', 'languages', 'languages_mode', 'query', 'referrer',
                 'user_agent', 'user_agent_mode', 'ips', 'ips_mode', 'asns', 'asns_mode', 'hostname', 'hostname_mode') THEN
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
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.conditions -> 'param') AS kk WHERE kk IN ('equals', 'contains', 'present')) <> 1 THEN
      RAISE EXCEPTION 'rules.conditions: param needs exactly one of equals, contains or present' USING ERRCODE = 'check_violation';
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

  -- IPs and CIDR ranges: 1 to 200, each one a valid inet ("1.2.3.4", "10.0.0.0/8", "2001:db8::/32").
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
  -- AS numbers: 1 to 200 integers from 1 to 4294967295.
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
  -- Hostname: a regex like the User-Agent's.
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
  -- A mode only goes with its list.
  IF (NEW.conditions ? 'ips_mode' AND (NEW.conditions ->> 'ips_mode' <> 'block' OR NOT NEW.conditions ? 'ips'))
     OR (NEW.conditions ? 'asns_mode' AND (NEW.conditions ->> 'asns_mode' <> 'block' OR NOT NEW.conditions ? 'asns'))
     OR (NEW.conditions ? 'hostname_mode' AND (NEW.conditions ->> 'hostname_mode' <> 'block' OR NOT NEW.conditions ? 'hostname')) THEN
    RAISE EXCEPTION 'rules.conditions: a mode needs its list and can only be "block"' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION pages.rules_check() FROM public, anon, authenticated;
