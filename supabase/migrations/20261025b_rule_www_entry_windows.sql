-- Rules: `www_entry` carries its own windows (the owner, 25/10: the times live in
-- the rule, editable in the dashboard). {token_hours, cookie_days}: the rule
-- matches when the browser has no dop_www from the last cookie_days (0 = the
-- cookie never counts) and the URL's sub21 is older than token_hours (or absent)
-- — server/src/sub0.php, www_entry_valid. Replaces 20261025a's "missing" (no rule
-- used it). rule_save's carry-over of the key (20261025a) is unchanged.

CREATE OR REPLACE FUNCTION pages.rule_conditions_check(p_c jsonb, p_at text, p_nested boolean DEFAULT false)
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
    p_c - ARRAY['cores', 'battery', 'charging', 'net_rtt_max', 'net_downlink_below', 'net_downlink_min', 'net_type', 'gl', 'www_entry', 'except'],
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


  FOREACH k IN ARRAY ARRAY['net_rtt_max', 'net_downlink_below', 'net_downlink_min'] LOOP
    IF NOT p_c ? k THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(p_c -> k) <> 'number' THEN
      RAISE EXCEPTION '%: % must be a number', p_at, k USING ERRCODE = 'check_violation';
    END IF;
    v := (p_c ->> k)::numeric;
    IF k = 'net_rtt_max' AND (v <> trunc(v) OR v NOT BETWEEN 1 AND 10000) THEN
      RAISE EXCEPTION '%: net_rtt_max must be a whole number, 1 to 10000', p_at USING ERRCODE = 'check_violation';
    END IF;
    IF k <> 'net_rtt_max' AND v NOT BETWEEN 0.01 AND 100 THEN
      RAISE EXCEPTION '%: % must be 0.01 to 100', p_at, k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF p_c ? 'net_type' AND NOT coalesce((p_c ->> 'net_type') = ANY (ARRAY['slow-2g', '2g', '3g', '4g']), false) THEN
    RAISE EXCEPTION '%: net_type must be slow-2g, 2g, 3g or 4g', p_at USING ERRCODE = 'check_violation';
  END IF;

  IF p_c ? 'www_entry' THEN
    IF jsonb_typeof(p_c -> 'www_entry') <> 'object'
       OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_c -> 'www_entry') x) IS DISTINCT FROM ARRAY['cookie_days', 'token_hours']
       OR jsonb_typeof(p_c -> 'www_entry' -> 'token_hours') <> 'number'
       OR jsonb_typeof(p_c -> 'www_entry' -> 'cookie_days') <> 'number' THEN
      RAISE EXCEPTION '%: www_entry must be {token_hours, cookie_days}', p_at USING ERRCODE = 'check_violation';
    END IF;
    v := (p_c -> 'www_entry' ->> 'token_hours')::numeric;
    IF v <> trunc(v) OR v NOT BETWEEN 1 AND 168 THEN
      RAISE EXCEPTION '%: www_entry.token_hours must be a whole number, 1 to 168', p_at USING ERRCODE = 'check_violation';
    END IF;
    v := (p_c -> 'www_entry' ->> 'cookie_days')::numeric;
    IF v <> trunc(v) OR v NOT BETWEEN 0 AND 30 THEN
      RAISE EXCEPTION '%: www_entry.cookie_days must be a whole number, 0 to 30', p_at USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_c ? 'gl' THEN
    IF jsonb_typeof(p_c -> 'gl') <> 'array' OR jsonb_array_length(p_c -> 'gl') NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION '%: gl must be a list of 1 to 50 WebGL renderers', p_at USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_c -> 'gl') e
      WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') NOT BETWEEN 1 AND 60
    ) THEN
      RAISE EXCEPTION '%: each gl renderer is a string of 1 to 60 characters', p_at USING ERRCODE = 'check_violation';
    END IF;
  END IF;

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
