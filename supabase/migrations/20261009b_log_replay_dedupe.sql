-- pages.log_replay skips a hit that is already there.
--
-- A timeout doesn't mean the write failed: on 10/08 03:59 the gateway logged
-- 200 for log_hit calls the server had already given up on (5 s), so the
-- insert can land after the server spooled the hit — and the replay would
-- write it twice. A hit with a visit id is the same hit when that visit id
-- exists (it's new on every response); one without (redirects, safe pages)
-- when a hit from the same IP, host, path, query, User-Agent and decision
-- was written from 2 s before to 15 s after it (the live write lands after
-- the request: the 5 s timeout plus PostgREST's queue; ip + created_at is
-- indexed). A tighter window keeps a bot's real repeats of one URL apart —
-- only repeats under ~2 s apart collapse into one. The duplicate
-- still gets the spooled network lookups (the server never sent them, it
-- thought the hit wasn't written) and counts as ok.

CREATE OR REPLACE FUNCTION pages.log_replay(p_key text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  it jsonb;
  p jsonb;
  n jsonb;
  v_at timestamptz;
  v_id bigint;
  v_found boolean;
  v_visit text;
  v_pass integer;
  v_ok integer := 0;
  v_missing integer := 0;
  v_failed integer := 0;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.log_replay: invalid key' USING ERRCODE = '28000';
  END IF;
  IF coalesce(jsonb_typeof(p_items), '') <> 'array' OR jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION 'pages.log_replay: items must be a list of up to 1000' USING ERRCODE = '22023';
  END IF;

  FOR v_pass IN 1..2 LOOP
  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    -- Pass 1: the hits; pass 2: the notices.
    CONTINUE WHEN (v_pass = 1) <> (coalesce(it ->> 'k', '') IN ('hit', 'net'));
    BEGIN
      v_at := CASE WHEN jsonb_typeof(it -> 'at') = 'number'
                   THEN least(now(), greatest(now() - interval '1 day', to_timestamp((it ->> 'at')::double precision)))
                   ELSE now() END;
      v_visit := it ->> 'v';
      n := it -> 'net';
      v_found := true;

      CASE it ->> 'k'
      WHEN 'hit' THEN
        p := it -> 'p';
        v_id := NULL;
        IF coalesce(p ->> 'p_visit_id', '') ~ '^[0-9a-f]{32}$' THEN
          SELECT h.id INTO v_id FROM pages.hits h WHERE h.visit_id = p ->> 'p_visit_id' LIMIT 1;
        ELSIF nullif(p ->> 'p_ip', '') IS NOT NULL THEN
          SELECT h.id INTO v_id FROM pages.hits h
          WHERE h.ip = p ->> 'p_ip'
            AND h.created_at BETWEEN v_at - interval '2 seconds' AND v_at + interval '15 seconds'
            AND h.host = left(coalesce(p ->> 'p_host', ''), 253)
            AND h.path = left(coalesce(p ->> 'p_path', ''), 2048)
            AND h.query IS NOT DISTINCT FROM nullif(left(coalesce(p ->> 'p_query', ''), 2048), '')
            AND h.user_agent IS NOT DISTINCT FROM nullif(left(coalesce(p ->> 'p_user_agent', ''), 1024), '')
            AND h.decision IS NOT DISTINCT FROM nullif(left(coalesce(p ->> 'p_decision', ''), 64), '')
          LIMIT 1;
        END IF;
        IF v_id IS NOT NULL THEN
          -- Already written (the timed-out call landed): only its lookups.
          IF jsonb_typeof(n) = 'object' THEN
            PERFORM pages.log_hit_net(p_key, v_id, (n ->> 'asn')::integer, n ->> 'as_name', n ->> 'hostname', n -> 'rule_matches');
          END IF;
        ELSE
        v_id := pages.log_hit(
          p_key                => p_key,
          p_domain             => (p ->> 'p_domain')::uuid,
          p_host               => p ->> 'p_host',
          p_path               => p ->> 'p_path',
          p_outcome            => p ->> 'p_outcome',
          p_status             => (p ->> 'p_status')::integer,
          p_country            => p ->> 'p_country',
          p_device             => p ->> 'p_device',
          p_is_bot             => (p ->> 'p_is_bot')::boolean,
          p_referrer_host      => p ->> 'p_referrer_host',
          p_ip                 => p ->> 'p_ip',
          p_user_agent         => p ->> 'p_user_agent',
          p_hostname           => p ->> 'p_hostname',
          p_asn                => (p ->> 'p_asn')::integer,
          p_as_name            => p ->> 'p_as_name',
          p_cookies            => p ->> 'p_cookies',
          p_region             => p ->> 'p_region',
          p_route_id           => (p ->> 'p_route_id')::uuid,
          p_page_id            => (p ->> 'p_page_id')::uuid,
          p_slug               => p ->> 'p_slug',
          p_decision           => p ->> 'p_decision',
          p_query              => p ->> 'p_query',
          p_redirect_url       => p ->> 'p_redirect_url',
          p_visit_id           => p ->> 'p_visit_id',
          p_rule_label         => p ->> 'p_rule_label',
          p_rule               => p ->> 'p_rule',
          p_rule_tags          => p -> 'p_rule_tags',
          p_funnel             => p ->> 'p_funnel',
          p_rule_reason        => p ->> 'p_rule_reason',
          p_accept_language    => p ->> 'p_accept_language',
          p_gate_reason        => p ->> 'p_gate_reason',
          p_device_fingerprint => p -> 'p_device_fingerprint',
          p_ip_block           => p -> 'p_ip_block',
          p_is_vpn             => (p ->> 'p_is_vpn')::boolean,
          p_vpn_kind           => p ->> 'p_vpn_kind',
          p_vpn_name           => p ->> 'p_vpn_name'
        );
        IF v_id IS NOT NULL THEN
          UPDATE pages.hits SET created_at = v_at WHERE id = v_id;
          IF jsonb_typeof(n) = 'object' THEN
            PERFORM pages.log_hit_net(p_key, v_id, (n ->> 'asn')::integer, n ->> 'as_name', n ->> 'hostname', n -> 'rule_matches');
          END IF;
        END IF;
        END IF;
      WHEN 'net' THEN
        PERFORM pages.log_hit_net(p_key, (it ->> 'id')::bigint, (n ->> 'asn')::integer, n ->> 'as_name', n ->> 'hostname', n -> 'rule_matches');
      WHEN 'load' THEN
        v_found := pages.log_load(p_key, v_visit, (it ->> 'ms')::integer);
        UPDATE pages.hits SET loaded_at = v_at WHERE visit_id = v_visit AND loaded_at = now();
      WHEN 'click' THEN
        v_found := pages.log_click(p_key, v_visit);
        UPDATE pages.hits
        SET clicked_at = CASE WHEN clicked_at = now() THEN v_at ELSE clicked_at END,
            loaded_at = CASE WHEN loaded_at = now() THEN v_at ELSE loaded_at END
        WHERE visit_id = v_visit AND (clicked_at = now() OR loaded_at = now());
      WHEN 'interact' THEN
        v_found := pages.log_interact(p_key, v_visit, it ->> 'kind', (it ->> 'ms')::integer);
        UPDATE pages.hits SET interacted_at = v_at WHERE visit_id = v_visit AND interacted_at = now();
      WHEN 'duration' THEN
        v_found := pages.log_duration(p_key, v_visit, (it ->> 'ms')::integer);
      WHEN 'signals' THEN
        v_found := pages.log_signals(p_key, v_visit, it -> 'sg');
      ELSE
        RAISE EXCEPTION 'unknown item kind %', it ->> 'k';
      END CASE;

      IF v_found THEN
        v_ok := v_ok + 1;
      ELSE
        v_missing := v_missing + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'pages.log_replay: % item failed: %', it ->> 'k', SQLERRM;
    END;
  END LOOP;
  END LOOP;

  RETURN jsonb_build_object('ok', v_ok, 'missing', v_missing, 'failed', v_failed);
END $function$;

REVOKE ALL ON FUNCTION pages.log_replay(text, jsonb) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_replay(text, jsonb) TO anon, service_role;

COMMENT ON FUNCTION pages.log_replay(text, jsonb) IS
  'The delivery server''s log spool (hits and visit notices it could not write), replayed in order through the live log functions (a hit already written is not written again), with the timestamps moved back to when each happened. Returns {ok, missing, failed}.';
