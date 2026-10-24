<?php
declare(strict_types=1);

// ── pg.php: the calls straight to Postgres, PostgREST as the fallback ──

$pgLog = sys_get_temp_dir() . '/dayone-pg-test-' . getmypid() . '.log';
$pgPrevLog = (string) ini_get('error_log');
ini_set('error_log', $pgLog);
$pgLogged = static fn(string $needle): int => substr_count((string) @file_get_contents($pgLog), $needle);

// The statement: escaped, untyped constants in named notation; the answer as PostgREST's JSON.
same(
    'pg statement: a read → json_agg of the rows (through a subquery)',
    "SELECT coalesce(json_agg(r), '[]'::json) FROM (SELECT * FROM pages.resolve(p_host => E'a.com', p_path => E'/')) r",
    pg_statement('resolve', ['p_host' => 'a.com', 'p_path' => '/'], true),
);
same(
    'pg statement: a logging call → to_json of the value',
    "SELECT CASE WHEN pg_typeof(v) = 'void'::regtype THEN NULL ELSE to_json(v) END FROM (SELECT pages.log_load(p_key => E'k', p_load_ms => NULL) AS v) r",
    pg_statement('log_load', ['p_key' => 'k', 'p_load_ms' => null], false),
);
same('pg statement: a function name that isn\'t an identifier → PostgREST decides', null, pg_statement('log_hit(); drop', [], false));
same('pg statement: a parameter name that isn\'t → PostgREST decides', null, pg_statement('log_hit', ['p_x) --' => 1], false));
same('pg statement: a list key isn\'t a parameter name', null, pg_statement('log_hit', ['x'], false));
same('pg statement: a value that can\'t be written → PostgREST decides', null, pg_statement('log_signals', ['p_signals' => ["\xff"]], false));
check('pg statement: cta_content_get\'s ids go as a uuid[] literal',
    str_contains((string) pg_statement('cta_content_get', ['p_ids' => ['u1', 'u2'], 'p_key' => 'k'], true), "p_ids => E'{\"u1\",\"u2\"}'"));

// Values as escaped string constants, read as the parameter's own type
same('pg literal: null → NULL', 'NULL', pg_literal(null));
same('pg literal: booleans', ["E't'", "E'f'"], [pg_literal(true), pg_literal(false)]);
same('pg literal: numbers, quoted (an integer or a text parameter alike)', ["E'12'", "E'1.5'", "E'-3'"], [pg_literal(12), pg_literal(1.5), pg_literal(-3)]);
same('pg literal: quotes doubled, backslashes escaped', "E'it''s a \\\\ path'", pg_literal("it's a \\ path"));
same('pg literal: a NUL byte dropped (Postgres text can\'t hold it)', "E'ab'", pg_literal("a\0b"));
same('pg literal: an array is JSON (jsonb)', "E'{\"a\":[1,\"x''y\"],\"b\":null}'", pg_literal(['a' => [1, "x'y"], 'b' => null]));
same('pg literal: a list is JSON too', "E'[\"x\",\"y\"]'", pg_literal(['x', 'y']));
same('pg literal: an empty array → []', "E'[]'", pg_literal([]));
same('pg literal: a Postgres array, each item quoted', "E'{\"a\",\"b\\\\\"c\",\"d\\\\\\\\e\",NULL,\"1\",\"t\"}'", pg_literal(['a', 'b"c', 'd\\e', null, 1, true], true));
same('pg literal: a Postgres array of arrays can\'t be written', false, pg_literal([['x']], true));
same('pg literal: an object can\'t be written', false, pg_literal(new stdClass()));
same('pg literal: invalid UTF-8 in JSON can\'t be written', false, pg_literal(["\xff"]));

// The database's errors as PostgREST's statuses
same('pg status: a key that isn\'t ours (28000) → 403, as PostgREST answers it', 403, pg_http_status('28000'));
check('pg status: a key that isn\'t ours is never spooled', !log_spool_retryable(pg_http_status('28000')));
same('pg status: a RAISE → 400, never retried', 400, pg_http_status('P0001'));
same('pg status: a constraint → 409', 409, pg_http_status('23505'));
same('pg status: statement timeout → 503', 503, pg_http_status('57014'));
same('pg status: out of connections → 503', 503, pg_http_status('53300'));
same('pg status: connection failure → 503', 503, pg_http_status('08006'));
same('pg status: lock not available → 503', 503, pg_http_status('55P03'));
same('pg status: anything else → 500 (retried, like PostgREST)', 500, pg_http_status('XX000'));
check('pg status: every failure but a refusal is worth trying again', log_spool_retryable(pg_http_status('57014')) && !log_spool_retryable(pg_http_status('P0001')));
check('pg misfit: an unknown function or parameter → PostgREST', pg_misfit('42883'));
check('pg misfit: no grant → PostgREST', pg_misfit('42501'));
check('pg misfit: a value of the wrong shape → PostgREST', pg_misfit('22P02'));
check('pg misfit: a timeout is the database\'s, not the statement\'s', !pg_misfit('57014'));
check('pg misfit: a RAISE is an answer', !pg_misfit('P0001'));

// The protocol's pieces
same('pg frame: type, length (itself included), body', "Q\x00\x00\x00\x09abcd\x00", pg_frame('Q', "abcd\0"));
same('pg datarow: the first column', '{"a":1}', pg_first_column("\x00\x01\x00\x00\x00\x07" . '{"a":1}'));
same('pg datarow: NULL', null, pg_first_column("\x00\x01\xff\xff\xff\xff"));
same('pg datarow: no columns', null, pg_first_column("\x00\x00"));
same('pg error: SQLSTATE and message', ['42883', 'function x does not exist'], pg_error_fields("SERROR\0VERROR\0C42883\0Mfunction x does not exist\0\0"));

// SCRAM-SHA-256: RFC 7677's test vector
[$first, $scram] = pg_scram_first('rOprNGfwEbeRWgbNEkqO', 'user');
same('scram: the first message', 'n,,n=user,r=rOprNGfwEbeRWgbNEkqO', $first);
$challenge = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
[$final, $scram] = pg_scram_final($scram, $challenge, 'pencil') ?? [null, []];
same('scram: the proof', 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', $final);
check('scram: the server\'s signature', pg_scram_verify($scram, 'v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4='));
check('scram: a wrong server signature', !pg_scram_verify($scram, 'v=AAAATRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4='));
[, $scram] = pg_scram_first('abc');
same('scram: a challenge whose nonce isn\'t ours', null, pg_scram_final($scram, 'r=xyz123,s=c2FsdA==,i=4096', 'pw'));
same('scram: a challenge that only repeats our nonce', null, pg_scram_final($scram, 'r=abc,s=c2FsdA==,i=4096', 'pw'));
same('scram: no iterations', null, pg_scram_final($scram, 'r=abc1,s=c2FsdA==,i=0', 'pw'));

// The CA, and off when not configured
check('pg ca: the CA file is written', ($ca = pg_root_ca_file()) !== null && file_get_contents($ca) === PG_ROOT_CA);
check('pg ca: a PEM certificate', str_starts_with(PG_ROOT_CA, '-----BEGIN CERTIFICATE-----') && str_contains(PG_ROOT_CA, '-----END CERTIFICATE-----'));
same('pg: not configured → off', false, pg_configured());
same('pg target: not configured → none', null, pg_target());
same('pg call: off → PostgREST', ['fallback' => true], pg_call('resolve', ['p_host' => 'a.com'], true, 1000));

// The breaker: shared by the workers (the file's mtime)
@unlink(pg_breaker_file());
same('pg breaker: closed', false, pg_breaker_open());
@touch(pg_breaker_file());
check('pg breaker: open after a failure', pg_breaker_open());
same('pg link: breaker open → PostgREST', null, pg_link(['host' => '127.0.0.1', 'port' => 1, 'database' => 'x', 'user' => 'x', 'password' => 'x', 'ca' => null], hrtime(true) + 1_000_000_000));
@touch(pg_breaker_file(), time() - PG_BREAKER_SECONDS - 1);
same('pg breaker: closes after PG_BREAKER_SECONDS', false, pg_breaker_open());
@unlink(pg_breaker_file());

$refused = ['host' => '127.0.0.1', 'port' => 1, 'database' => 'x', 'user' => 'x', 'password' => 'x', 'ca' => null];
same('pg call: can\'t connect → PostgREST', ['fallback' => true], pg_call('resolve', ['p_host' => 'a.com'], true, 1000, $refused));
check('pg call: can\'t connect → the breaker opens', pg_breaker_open());
same('pg call: can\'t connect → logged once', 1, $pgLogged("can't connect"));
same('pg call: breaker open → PostgREST, without trying', ['fallback' => true], pg_call('resolve', ['p_host' => 'a.com'], true, 1000, $refused));
same('pg call: breaker open → nothing more logged', 1, $pgLogged("can't connect"));
@unlink(pg_breaker_file());

// ── Against a real Postgres: a throwaway database named dayone_pages_test, whose schema `pages`
// is replaced. PG_TEST_PORT, PG_TEST_ADMIN_PASSWORD (user postgres), PG_TEST_PASSWORD (a login role
// pages_test) and PG_TEST_CA (the CA of the server's certificate for "localhost"); the fixture needs
// the pgsql extension, the calls don't. ──

$pgTestPort = (int) getenv('PG_TEST_PORT');
if ($pgTestPort === 0 || !function_exists('pg_connect')) {
    echo "  skip pg calls against Postgres: set PG_TEST_PORT, PG_TEST_ADMIN_PASSWORD, PG_TEST_PASSWORD and PG_TEST_CA\n";
} else {
    $admin = @pg_connect("host=127.0.0.1 port=$pgTestPort dbname=dayone_pages_test user=postgres sslmode=disable password='"
        . addcslashes((string) getenv('PG_TEST_ADMIN_PASSWORD'), "'\\") . "'", PGSQL_CONNECT_FORCE_NEW);
    check('pg fixture: the test database (dayone_pages_test) is reachable', $admin !== false);
    if ($admin !== false) {
        pg_query($admin, <<<'SQL'
            DROP SCHEMA IF EXISTS pages CASCADE;
            CREATE SCHEMA pages;
            GRANT USAGE ON SCHEMA pages TO pages_test;
            CREATE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
            RETURNS TABLE(route_id uuid, priority integer, preserve_query boolean, gate jsonb, status_code smallint, content text)
            LANGUAGE sql AS $$
              SELECT '6aa47452-51a5-2a66-e725-b0ce00000001'::uuid, 3, true, '{"rules": [{"id": 1, "name": "Bot é"}]}'::jsonb, 302::smallint, NULL::text
              WHERE p_host = 'a.com' AND p_path = '/x' AND p_key = 'k' AND NOT p_with_content
            $$;
            CREATE FUNCTION pages.log_hit(p_key text, p_host text, p_status integer DEFAULT NULL, p_is_bot boolean DEFAULT NULL,
                                          p_rule_tags jsonb DEFAULT NULL, p_domain uuid DEFAULT NULL)
            RETURNS bigint LANGUAGE sql AS $$
              SELECT CASE WHEN p_status = 200 AND p_is_bot = false AND p_rule_tags = '["a","b"]'::jsonb THEN 42::bigint ELSE 0 END
            $$;
            CREATE FUNCTION pages.log_hit_net(p_key text, p_id bigint, p_asn integer DEFAULT NULL) RETURNS void
              LANGUAGE plpgsql AS $$ BEGIN END $$;
            CREATE FUNCTION pages.log_hit_net_sql(p_key text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
            CREATE FUNCTION pages.log_load(p_key text, p_visit_id text, p_load_ms integer DEFAULT NULL) RETURNS boolean
              LANGUAGE sql AS $$ SELECT p_visit_id = 'v1' $$;
            CREATE FUNCTION pages.log_replay(p_key text, p_items jsonb) RETURNS jsonb
              LANGUAGE sql AS $$ SELECT jsonb_build_object('ok', jsonb_array_length(p_items), 'missing', 0, 'failed', 0) $$;
            CREATE FUNCTION pages.echo(p_key text, p_text text, p_json jsonb) RETURNS jsonb
              LANGUAGE sql AS $$ SELECT jsonb_build_object('text', p_text, 'json', p_json) $$;
            CREATE FUNCTION pages.cta_content_get(p_ids uuid[], p_key text) RETURNS TABLE(cta_id uuid)
              LANGUAGE sql AS $$ SELECT unnest(p_ids) $$;
            CREATE FUNCTION pages.cta_preview_get(p_cta uuid, p_page uuid, p_key text) RETURNS TABLE(status text)
              LANGUAGE sql AS $$ SELECT 'three arguments' $$;
            CREATE FUNCTION pages.cta_preview_get(p_cta uuid, p_page uuid, p_video text, p_key text) RETURNS TABLE(status text, video text)
              LANGUAGE sql AS $$ SELECT 'four arguments', p_video $$;
            CREATE FUNCTION pages.refuse(p_key text) RETURNS boolean
              LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'server key not allowed'; END $$;
            CREATE FUNCTION pages.slow(p_key text) RETURNS boolean LANGUAGE sql AS $$ SELECT pg_sleep(1) IS NOT NULL $$;
            SQL);
        $u1 = '6aa47452-51a5-2a66-e725-b0ce00000001';
        $u2 = '6aa47452-51a5-2a66-e725-b0ce00000002';
        $role = ['database' => 'dayone_pages_test', 'user' => 'pages_test', 'password' => (string) getenv('PG_TEST_PASSWORD')];
        $tls = ['host' => 'localhost', 'port' => $pgTestPort, 'ca' => (string) getenv('PG_TEST_CA')] + $role;
        $plain = ['host' => '127.0.0.1', 'port' => $pgTestPort, 'ca' => null] + $role;
        $sessions = static fn(): int => (int) pg_fetch_result(pg_query($admin, "SELECT count(*) FROM pg_stat_activity WHERE usename = 'pages_test'"), 0, 0);

        // A connection that can't start: refused before any good one on the same address (PHP keeps sockets by address).
        same('pg startup: a wrong password → PostgREST', ['fallback' => true], pg_call('log_load', ['p_key' => 'k', 'p_visit_id' => 'v1'], false, 2000, ['password' => 'wrong'] + $plain));
        same('pg startup: a wrong password → logged with its SQLSTATE', 1, $pgLogged('refused (28P01'));
        @unlink(pg_breaker_file());
        same('pg startup: a certificate our CA didn\'t sign → PostgREST', ['fallback' => true], pg_call('log_load', ['p_key' => 'k', 'p_visit_id' => 'v1'], false, 2000, ['ca' => pg_root_ca_file()] + $tls));
        same('pg startup: that certificate → logged', 1, $pgLogged('TLS failed'));
        @unlink(pg_breaker_file());

        foreach (['TLS' => $tls, 'plain' => $plain] as $how => $target) {
            $r = pg_call('resolve', ['p_host' => 'a.com', 'p_path' => '/x', 'p_with_content' => false, 'p_key' => 'k'], true, 2000, $target);
            same("pg call ($how): rows as PostgREST's JSON, types kept", [
                'fallback' => false, 'ok' => true, 'status' => 200, 'value' => [[
                    'route_id' => $u1, 'priority' => 3, 'preserve_query' => true,
                    'gate' => ['rules' => [['id' => 1, 'name' => 'Bot é']]], 'status_code' => 302, 'content' => null,
                ]],
            ], $r);
        }
        $target = $tls;
        same('pg call: no rows → []', [], pg_call('resolve', ['p_host' => 'b.com', 'p_path' => '/x', 'p_with_content' => false, 'p_key' => 'k'], true, 2000, $target)['value'] ?? null);
        same('pg call: a bigint, from integer, boolean and jsonb values', 42, pg_call('log_hit', [
            'p_key' => 'k', 'p_host' => 'a.com', 'p_status' => 200, 'p_is_bot' => false, 'p_rule_tags' => ['a', 'b'], 'p_domain' => null,
        ], false, 2000, $target)['value'] ?? null);
        same('pg call: a void plpgsql function → null, like PostgREST\'s 204', ['fallback' => false, 'ok' => true, 'status' => 200, 'value' => null],
            pg_call('log_hit_net', ['p_key' => 'k', 'p_id' => 42, 'p_asn' => 13335], false, 2000, $target));
        same('pg call: a void SQL function → null too', ['fallback' => false, 'ok' => true, 'status' => 200, 'value' => null],
            pg_call('log_hit_net_sql', ['p_key' => 'k'], false, 2000, $target));
        same('pg call: a boolean', [true, false], [
            pg_call('log_load', ['p_key' => 'k', 'p_visit_id' => 'v1', 'p_load_ms' => 900], false, 2000, $target)['value'] ?? null,
            pg_call('log_load', ['p_key' => 'k', 'p_visit_id' => 'v2'], false, 2000, $target)['value'] ?? null,
        ]);
        same('pg call: a jsonb answer, decoded (jsonb\'s own key order)', ['ok' => 2, 'failed' => 0, 'missing' => 0],
            pg_call('log_replay', ['p_key' => 'k', 'p_items' => [['k' => 'load'], ['k' => 'click']]], false, 2000, $target)['value'] ?? null);
        $odd = "it's a \\ back\\\\slash, \"quoted\", é, \n line, $1, E'x', \\u0041";
        same('pg call: text and JSON values arrive as sent',
            ['json' => ['k' => $odd, 'n' => [1.5, true, null]], 'text' => $odd],
            pg_call('echo', ['p_key' => 'k', 'p_text' => $odd, 'p_json' => ['k' => $odd, 'n' => [1.5, true, null]]], false, 2000, $target)['value'] ?? null);
        same('pg call: a NUL byte in a text value is dropped', ['json' => null, 'text' => 'ab'],
            pg_call('echo', ['p_key' => 'k', 'p_text' => "a\0b", 'p_json' => null], false, 2000, $target)['value'] ?? null);
        same('pg call: a NUL in JSON (\\u0000, refused by jsonb, as through PostgREST) → PostgREST', ['fallback' => true],
            pg_call('echo', ['p_key' => 'k', 'p_text' => 'x', 'p_json' => ["a\0b"]], false, 2000, $target));
        same('pg call: a uuid[] parameter; a one-column TABLE still gives objects', [['cta_id' => $u1], ['cta_id' => $u2]],
            pg_call('cta_content_get', ['p_ids' => [$u1, $u2], 'p_key' => 'k'], true, 2000, $target)['value'] ?? null);
        same('pg call: the version of the function its parameter names pick', [['status' => 'four arguments', 'video' => 'vid']],
            pg_call('cta_preview_get', ['p_cta' => $u1, 'p_page' => $u2, 'p_video' => 'vid', 'p_key' => 'k'], true, 2000, $target)['value'] ?? null);

        same('pg call: a RAISE → 400, not through PostgREST', ['fallback' => false, 'ok' => false, 'status' => 400, 'error' => 'SQLSTATE P0001'],
            pg_call('refuse', ['p_key' => 'k'], false, 2000, $target));
        same('pg call: a parameter the function doesn\'t have (a migration ahead of the code) → PostgREST', ['fallback' => true],
            pg_call('log_load', ['p_key' => 'k', 'p_visit_id' => 'v1', 'p_new' => 1], false, 2000, $target));
        same('pg call: that refusal is logged', 1, $pgLogged('postgres refused log_load (42883'));
        same('pg call: a value of the wrong shape → PostgREST', ['fallback' => true],
            pg_call('cta_content_get', ['p_ids' => ['not a uuid'], 'p_key' => 'k'], true, 2000, $target));
        same('pg call: still answering after the refusals', true,
            pg_call('log_load', ['p_key' => 'k', 'p_visit_id' => 'v1'], false, 2000, $target)['value'] ?? null);
        same('pg link: one connection per address, kept between calls', 2, $sessions());
        same('pg link: no breaker after good calls', false, pg_breaker_open());

        // A call that runs out of time closes its connection; the next one opens a new one.
        $t = microtime(true);
        same('pg call: out of time → no answer (status 0), not through PostgREST',
            ['fallback' => false, 'ok' => false, 'status' => 0, 'error' => 'timeout'], pg_call('slow', ['p_key' => 'k'], false, 150, $target));
        check('pg call: out of time → back within its time limit', microtime(true) - $t < 0.4, sprintf('%.3f s', microtime(true) - $t));
        $t = microtime(true);
        same('pg call: after a timeout, a new connection answers', true,
            pg_call('log_load', ['p_key' => 'k', 'p_visit_id' => 'v1'], false, 2000, $target)['value'] ?? null);
        check('pg call: …without waiting for the slow one', microtime(true) - $t < 0.5, sprintf('%.3f s', microtime(true) - $t));
        same('pg call: a read out of time → no answer, not PostgREST', 0, pg_call('slow', ['p_key' => 'k'], false, 100, $target)['status'] ?? null);

        usleep(1_100_000); // the slow calls end in the database before the schema goes
        pg_query($admin, 'DROP SCHEMA pages CASCADE');
        pg_close($admin);
    }
}

ini_set('error_log', $pgPrevLog);
@unlink($pgLog);
@unlink(pg_breaker_file());
