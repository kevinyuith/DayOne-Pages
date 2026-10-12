-- Test a rule before saving it: run its conditions over the hits already logged.
--
-- pages.rule_backtest(conditions, since) translates a rule's conditions into a
-- WHERE over pages.hits (the same contract as server/src/rules.php, as far as a
-- hit records it) and says what the rule would have matched since `since`:
-- how many requests and IPs, which of them another rule already caught, how
-- many got the safe page without a rule, stopped at the checkpoint, were not
-- found, or reached the funnel — and of those, how many loaded and interacted.
--
-- What a hit can't tell is left out and named in `ignored` (the count is then
-- an upper bound): prefetch, every device signal (they only exist inside the
-- checkpoint), and an exception that uses one of them. `approximate` names the
-- conditions a hit only records in part: referrer (the hit keeps the host, not
-- the whole Referer) and hostname (a failed lookup and "no PTR" are both NULL).
--
-- Only literals reach the SQL (format %L). A rule scoped to platforms
-- (sub11_in) reads the platform index and may look back 7 days; any other rule
-- looks back at most 24 hours (a scan of every hit).

-- A URL-encoded value with its ASCII escapes decoded ('+' is a space). A
-- multibyte escape (%C3%A9) stays as it is: a hit's value is compared with a
-- rule's literal, and the rules' values are ASCII.
CREATE OR REPLACE FUNCTION pages.url_decode_ascii(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN p !~ '[%+]' THEN p
    ELSE (
      SELECT string_agg(
               CASE WHEN r.m[1] IS NOT NULL
                         AND ('x' || substr(r.m[1], 2, 2))::bit(8)::int BETWEEN 1 AND 127
                    THEN chr(('x' || substr(r.m[1], 2, 2))::bit(8)::int)
                    ELSE coalesce(r.m[1], r.m[2]) END,
               '' ORDER BY r.ord)
      FROM regexp_matches(replace(p, '+', ' '), '(%[0-9A-Fa-f]{2})|([^%]+|%)', 'g') WITH ORDINALITY AS r(m, ord)
    )
  END;
$function$;

-- The SQL predicate (over pages.hits h) of one condition object, and what it couldn't express.
-- Returns {"sql": "...", "ignored": [keys], "approximate": [keys]}.
CREATE OR REPLACE FUNCTION pages.rule_backtest_predicate(p_c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_parts text[] := array[]::text[];
  v_ignored text[] := array[]::text[];
  v_approx text[] := array[]::text[];
  k text;
  q record;
  v_name text;
  v_esc text;
  v_present text;
  v_value text;
  v_list text;
  v_in text;
  v_exc jsonb;
  e jsonb;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_c) LOOP
    CASE k
      -- Their partner key decides with them.
      WHEN 'countries_mode', 'languages_mode', 'user_agent_mode', 'ips_mode', 'asns_mode', 'hostname_mode' THEN
        NULL;

      WHEN 'sub1', 'sub11' THEN
        v_parts := v_parts || format(
          'lower(pages.url_decode_ascii(substring(h.query from %L))) = lower(%L)',
          '(?:^|&)' || k || '=([^&]*)', p_c ->> k);

      WHEN 'sub11_in' THEN
        v_parts := v_parts || format('h.platform = ANY (%L::text[])',
          (SELECT array_agg(x) FROM jsonb_array_elements_text(p_c -> 'sub11_in') x)::text);

      WHEN 'param' THEN
        v_name := p_c -> 'param' ->> 'name';
        v_esc := regexp_replace(v_name, '([.~-])', '\\\1', 'g');
        v_present := format('(coalesce(h.query, %L) ~ %L)', '', '(^|&)' || v_esc || '(=|&|$)');
        v_value := format('coalesce(pages.url_decode_ascii(substring(h.query from %L)), %L)', '(?:^|&)' || v_esc || '=([^&]*)', '');
        IF p_c -> 'param' ? 'equals' THEN
          v_parts := v_parts || format('(%s AND lower(%s) = lower(%L))', v_present, v_value, p_c -> 'param' ->> 'equals');
        ELSIF p_c -> 'param' ? 'not_equals' THEN
          v_parts := v_parts || format('(%s AND lower(%s) <> lower(%L))', v_present, v_value, p_c -> 'param' ->> 'not_equals');
        ELSIF p_c -> 'param' ? 'absent_or_equals' THEN
          v_parts := v_parts || format('(NOT %s OR lower(%s) = lower(%L))', v_present, v_value, p_c -> 'param' ->> 'absent_or_equals');
        ELSIF p_c -> 'param' ? 'contains' THEN
          v_parts := v_parts || format('(%s AND strpos(lower(%s), lower(%L)) > 0)', v_present, v_value, p_c -> 'param' ->> 'contains');
        ELSE
          v_parts := v_parts || v_present;
        END IF;

      WHEN 'query' THEN
        FOR q IN SELECT key, value FROM jsonb_each(p_c -> 'query') LOOP
          v_esc := regexp_replace(q.key, '([.\[\]~-])', '\\\1', 'g');
          v_present := format('(coalesce(h.query, %L) ~ %L)', '', '(^|&)' || v_esc || '(=|&|$)');
          v_value := format('coalesce(pages.url_decode_ascii(substring(h.query from %L)), %L)', '(?:^|&)' || v_esc || '=([^&]*)', '');
          IF q.value = '"present"'::jsonb THEN
            v_parts := v_parts || v_present;
          ELSIF q.value = '"absent"'::jsonb THEN
            v_parts := v_parts || ('NOT ' || v_present);
          ELSIF q.value = '"empty"'::jsonb THEN
            v_parts := v_parts || format('(NOT %s OR %s = %L)', v_present, v_value, '');
          ELSIF jsonb_typeof(q.value) = 'object' AND q.value ? 'equals' THEN
            -- Case-sensitive, like conditions.php.
            v_parts := v_parts || format('(%s AND %s = %L)', v_present, v_value, q.value ->> 'equals');
          ELSE
            v_parts := v_parts || 'false'::text;
          END IF;
        END LOOP;

      WHEN 'countries' THEN
        v_in := format('(coalesce(h.country, %L) <> %L AND h.country = ANY (%L::text[]))', '', '',
          (SELECT array_agg(upper(x)) FROM jsonb_array_elements_text(p_c -> 'countries') x)::text);
        v_parts := v_parts || CASE WHEN p_c ->> 'countries_mode' = 'block' THEN 'NOT ' || v_in ELSE v_in END;

      WHEN 'devices' THEN
        v_parts := v_parts || format('h.device = ANY (%L::text[])',
          (SELECT array_agg(x) FROM jsonb_array_elements_text(p_c -> 'devices') x)::text);

      WHEN 'languages' THEN
        v_in := format(
          '(EXISTS (SELECT 1 FROM regexp_split_to_table(coalesce(h.accept_language, %L), %L) AS t(part)'
          ' WHERE lower(split_part(btrim(split_part(t.part, %L, 1)), %L, 1)) = ANY (%L::text[])))',
          '', ',', ';', '-', (SELECT array_agg(lower(x)) FROM jsonb_array_elements_text(p_c -> 'languages') x)::text);
        v_parts := v_parts || CASE WHEN p_c ->> 'languages_mode' = 'block' THEN 'NOT ' || v_in ELSE v_in END;

      WHEN 'referrer' THEN
        v_approx := v_approx || k;
        v_parts := v_parts || format('strpos(lower(coalesce(h.referrer_host, %L)), lower(%L)) > 0', '', p_c ->> 'referrer');

      WHEN 'referrer_absent' THEN
        v_parts := v_parts || format('coalesce(h.referrer_host, %L) = %L', '', '');

      WHEN 'user_agent' THEN
        v_in := format('(coalesce(h.user_agent, %L) ~* %L)', '', p_c ->> 'user_agent');
        v_parts := v_parts || CASE WHEN p_c ->> 'user_agent_mode' = 'block' THEN 'NOT ' || v_in ELSE v_in END;

      WHEN 'accept_languages' THEN
        v_in := format(
          '(SELECT count(DISTINCT lower(btrim(split_part(t.part, %L, 1)))) FROM regexp_split_to_table(coalesce(h.accept_language, %L), %L) AS t(part)'
          ' WHERE lower(btrim(split_part(t.part, %L, 1))) ~ %L)',
          ';', '', ',', ';', '^[a-z]{1,8}(-[a-z0-9]{1,8})*$');
        IF p_c -> 'accept_languages' ? 'min' THEN
          v_parts := v_parts || format('%s >= %s', v_in, (p_c -> 'accept_languages' ->> 'min')::int);
        END IF;
        IF p_c -> 'accept_languages' ? 'max' THEN
          v_parts := v_parts || format('%s <= %s', v_in, (p_c -> 'accept_languages' ->> 'max')::int);
        END IF;

      WHEN 'ips' THEN
        v_in := format('(h.ip::inet <<= ANY (%L::inet[]))',
          (SELECT array_agg(x) FROM jsonb_array_elements_text(p_c -> 'ips') x)::text);
        v_parts := v_parts || format('(pg_input_is_valid(h.ip, %L) AND %s%s)', 'inet',
          CASE WHEN p_c ->> 'ips_mode' = 'block' THEN 'NOT ' ELSE '' END, v_in);

      WHEN 'asns' THEN
        v_list := (SELECT array_agg((x)::bigint) FROM jsonb_array_elements_text(p_c -> 'asns') x)::text;
        v_parts := v_parts || CASE WHEN p_c ->> 'asns_mode' = 'block'
          THEN format('(coalesce(h.asn, 0) > 0 AND NOT (h.asn = ANY (%L::bigint[])))', v_list)
          ELSE format('(h.asn = ANY (%L::bigint[]))', v_list) END;

      WHEN 'hostname' THEN
        v_approx := v_approx || k;
        v_in := format('(coalesce(h.hostname, %L) ~* %L)', '', p_c ->> 'hostname');
        v_parts := v_parts || CASE WHEN p_c ->> 'hostname_mode' = 'block' THEN 'NOT ' || v_in ELSE v_in END;

      WHEN 'except' THEN
        FOR e IN SELECT value FROM jsonb_array_elements(p_c -> 'except') LOOP
          v_exc := pages.rule_backtest_predicate(e - 'except');
          IF jsonb_array_length(v_exc -> 'ignored') > 0 THEN
            -- An exception the hits can't decide is left out: it could only exempt more.
            v_ignored := v_ignored || 'except'::text;
          ELSE
            v_parts := v_parts || format('NOT coalesce((%s), false)', v_exc ->> 'sql');
            v_approx := v_approx || ARRAY(SELECT jsonb_array_elements_text(v_exc -> 'approximate'));
          END IF;
        END LOOP;

      ELSE
        -- prefetch, eval_cookie and every device signal: not in the hit.
        v_ignored := v_ignored || k;
    END CASE;
  END LOOP;

  RETURN jsonb_build_object(
    'sql', CASE WHEN cardinality(v_parts) = 0 THEN 'true'
                ELSE (SELECT string_agg(format('coalesce((%s), false)', x), ' AND ') FROM unnest(v_parts) x) END,
    'ignored', to_jsonb(ARRAY(SELECT DISTINCT x FROM unnest(v_ignored) x ORDER BY 1)),
    'approximate', to_jsonb(ARRAY(SELECT DISTINCT x FROM unnest(v_approx) x ORDER BY 1)));
END $function$;

CREATE OR REPLACE FUNCTION pages.rule_backtest(p_conditions jsonb, p_since timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_c jsonb := coalesce(p_conditions, '{}'::jsonb);
  v_pred jsonb;
  v_platforms text[];
  v_since timestamptz;
  v_out jsonb;
BEGIN
  -- The same validation as a saved rule (a bad regex or key raises check_violation here).
  PERFORM pages.rule_conditions_check(v_c, 'conditions');
  v_pred := pages.rule_backtest_predicate(v_c);
  v_platforms := (SELECT array_agg(x) FROM jsonb_array_elements_text(v_c -> 'sub11_in') x);
  v_since := greatest(coalesce(p_since, now() - interval '1 day'),
                      now() - CASE WHEN v_platforms IS NULL THEN interval '1 day' ELSE interval '7 days' END);

  EXECUTE format($q$
    WITH m AS (
      SELECT h.ip, h.rule, coalesce(h.platform, '') AS platform, h.loaded_at, h.interacted_at,
             CASE WHEN h.rule IS NOT NULL THEN 'caught'
                  WHEN h.status_code = 404 THEN 'not_found'
                  WHEN h.decision = 'SERVE · GATE' AND h.status_code = 200 THEN 'funnel'
                  WHEN h.decision LIKE '%%GATE-SAFE%%' THEN 'safe_no_rule'
                  WHEN h.decision LIKE '%%EVAL%%' THEN 'checkpoint'
                  ELSE 'other' END AS kind
      FROM pages.hits h
      WHERE h.created_at >= %L
        AND h.outcome <> 'redirect'
        %s
        AND %s
    )
    SELECT jsonb_build_object(
      'total', count(*),
      'ips', count(DISTINCT m.ip),
      'caught', count(*) FILTER (WHERE m.kind = 'caught'),
      'safe_no_rule', count(*) FILTER (WHERE m.kind = 'safe_no_rule'),
      'checkpoint', count(*) FILTER (WHERE m.kind = 'checkpoint'),
      'not_found', count(*) FILTER (WHERE m.kind = 'not_found'),
      'funnel', count(*) FILTER (WHERE m.kind = 'funnel'),
      'funnel_loaded', count(*) FILTER (WHERE m.kind = 'funnel' AND m.loaded_at IS NOT NULL),
      'funnel_interacted', count(*) FILTER (WHERE m.kind = 'funnel' AND m.interacted_at IS NOT NULL),
      'other', count(*) FILTER (WHERE m.kind = 'other'),
      'caught_by', coalesce((
        SELECT jsonb_agg(jsonb_build_object('rule', t.rule, 'n', t.n) ORDER BY t.n DESC)
        FROM (SELECT m2.rule, count(*) AS n FROM m m2 WHERE m2.kind = 'caught' GROUP BY 1 ORDER BY 2 DESC LIMIT 5) t
      ), '[]'::jsonb),
      'platforms', coalesce((
        SELECT jsonb_agg(jsonb_build_object('platform', t.platform, 'n', t.n) ORDER BY t.n DESC)
        FROM (SELECT m3.platform, count(*) AS n FROM m m3 GROUP BY 1 ORDER BY 2 DESC LIMIT 6) t
      ), '[]'::jsonb))
    FROM m
  $q$,
  v_since,
  CASE WHEN v_platforms IS NULL THEN '' ELSE format('AND h.platform = ANY (%L::text[])', v_platforms::text) END,
  v_pred ->> 'sql')
  INTO v_out;

  RETURN v_out || jsonb_build_object(
    'since', v_since,
    'ignored', v_pred -> 'ignored',
    'approximate', v_pred -> 'approximate');
END $function$;

REVOKE ALL ON FUNCTION pages.url_decode_ascii(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_backtest_predicate(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.rule_backtest(jsonb, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.rule_backtest(jsonb, timestamptz) TO service_role;
