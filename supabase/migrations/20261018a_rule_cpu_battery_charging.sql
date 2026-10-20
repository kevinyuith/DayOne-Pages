-- Device checkpoint conditions: exact CPU core count, battery percentage and charging state.

ALTER FUNCTION pages.rule_conditions_check(jsonb, text, boolean)
  RENAME TO rule_conditions_check_legacy;

CREATE FUNCTION pages.rule_conditions_check(p_c jsonb, p_at text, p_nested boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  k text;
  t record;
  v numeric;
  i integer := 0;
BEGIN
  IF coalesce(jsonb_typeof(p_c), '') <> 'object' THEN
    PERFORM pages.rule_conditions_check_legacy(p_c, p_at, p_nested);
    RETURN;
  END IF;

  PERFORM pages.rule_conditions_check_legacy(
    p_c - ARRAY['cores', 'battery', 'charging', 'except'],
    p_at,
    p_nested
  );

  FOREACH k IN ARRAY ARRAY['cores', 'battery', 'charging'] LOOP
    IF NOT p_c ? k THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(p_c -> k) <> 'number' THEN
      RAISE EXCEPTION '%: % must be a number', p_at, k USING ERRCODE = 'check_violation';
    END IF;
    v := (p_c ->> k)::numeric;
    IF v <> trunc(v) THEN
      RAISE EXCEPTION '%: % must be a whole number', p_at, k USING ERRCODE = 'check_violation';
    END IF;
    IF (k = 'cores' AND v NOT BETWEEN 1 AND 1024)
       OR (k = 'battery' AND v NOT BETWEEN 0 AND 100)
       OR (k = 'charging' AND v NOT IN (0, 1)) THEN
      RAISE EXCEPTION '%: invalid % value', p_at, k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF p_c ? 'except' THEN
    IF p_nested THEN
      RAISE EXCEPTION '%: an exception can''t have exceptions', p_at USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(jsonb_typeof(p_c -> 'except'), '') <> 'array'
       OR jsonb_array_length(p_c -> 'except') NOT BETWEEN 1 AND 10 THEN
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
GRANT EXECUTE ON FUNCTION pages.rule_conditions_check(jsonb, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION pages.rule_conditions_check_legacy(jsonb, text, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rule_conditions_check_legacy(jsonb, text, boolean) TO service_role;

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
