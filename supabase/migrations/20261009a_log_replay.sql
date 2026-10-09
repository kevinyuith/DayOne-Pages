-- The delivery server's log spool, replayed in batches: pages.log_replay.
--
-- A hit or a visit notice the server couldn't write (Supabase timed out, or
-- answered 5xx: the database out of connections, PostgREST reloading its
-- schema cache) waits on the server's disk (cache/log-spool.jsonl, with the
-- moment it happened) and comes back here later, many per call. Each item
-- goes through the SAME function the live path uses (log_hit, log_hit_net,
-- log_load, log_click, log_interact, log_duration, log_signals), so the
-- validation and the triggers are the ones every hit gets; then the
-- timestamps that function set to now() are moved back to when it happened
-- (bounded to the last day, never in the future):
--
--   hit       log_hit(p) [+ log_hit_net(net)]   → created_at = at
--   net       log_hit_net(id, net)               (a hit written, its lookups not)
--   load      log_load(v, ms)                    → loaded_at = at, if this call set it
--   click     log_click(v)                       → clicked_at / loaded_at = at, same
--   interact  log_interact(v, kind, ms)          → interacted_at = at, same
--   duration  log_duration(v, ms)
--   signals   log_signals(v, sg)
--
-- The hits (and nets) go first, then the notices, each group in the spool's
-- order — a notice can be spooled a moment before its own hit (the hit
-- waits for its network lookups). Each item runs in its own
-- subtransaction: a bad one is counted as failed and the rest go on. A notice
-- whose hit doesn't exist is "missing" (the server drops it). Returns
-- {"ok", "missing", "failed"}.
--
-- A replayed hit takes is_unique when it's inserted: an IP + User-Agent seen
-- again while it waited counts the later hit as the unique one — the pair
-- still counts one unique click.
--
-- log_hit gains a parameter → add it here too (the call below names each one).

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
  'The delivery server''s log spool (hits and visit notices it could not write), replayed in order through the live log functions, with the timestamps moved back to when each happened. Returns {ok, missing, failed}.';
