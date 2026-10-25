-- Rules: the `www_entry` condition. "missing" = the click didn't come through the
-- www entry: no dop_www in this browser (a token at most 5 days old, any click's)
-- and the URL's sub21 over 4 hours old or absent (server/src/sub0.php,
-- www_entry_valid). The request decides it; a hit can't (its cookie and sub21 are
-- encrypted), so rule_backtest lists it as ignored, like prefetch.
--
-- rule_conditions_check: the body of 20261022a with `www_entry` stripped before
-- the legacy check and validated here. rule_save: a caller without p_full
-- (dayone-main's traffic-rules dialog) keeps `www_entry` as it was.

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

  IF p_c ? 'www_entry' AND p_c -> 'www_entry' IS DISTINCT FROM '"missing"'::jsonb THEN
    RAISE EXCEPTION '%: www_entry must be "missing"', p_at USING ERRCODE = 'check_violation';
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

CREATE OR REPLACE FUNCTION pages.rule_save(p_id uuid, p_name text, p_label text, p_tags jsonb, p_conditions jsonb, p_is_active boolean, p_reason text DEFAULT ''::text, p_is_monitor boolean DEFAULT NULL::boolean, p_full boolean DEFAULT false)
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
    FOREACH k IN ARRAY array['sub11_in', 'except', 'zoomed', 'www_entry'] LOOP
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
