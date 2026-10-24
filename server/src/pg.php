<?php
/**
 * The database calls straight to Postgres, through Supabase's pooler
 * (Supavisor, transaction mode) — the same pages.* functions supabase.php
 * calls through PostgREST, without PostgREST in between.
 *
 * Why (24/10/2026): PostgREST closes on its own. It reloads its schema cache —
 * the 498 relations and 1,959 functions of every schema the project exposes —
 * at every DDL anywhere in the database (89 times in a day), and while a reload
 * fails it answers 503 to everything: on 23/10 at 22:15 that was 3 s of 503 for
 * resolve, log_hit, log_load and dayone-main's dot at once. Its pool was
 * re-initialized 34 times that day, and Cloudflare's WAF in front of
 * supabase.co refuses a hit by its payload. A connection of our own to the
 * pooler goes around all of it.
 *
 * Same functions, same arguments, same answers: each call is a simple query,
 * `pages.<fn>(p_a => E'…', p_b => NULL, …)`, every value an escaped string
 * constant — Postgres reads each one as the function's own parameter type (a
 * JSON text becomes jsonb, '12' an integer), so a new parameter needs nothing
 * here — and the answer is the JSON PostgREST would send: json_agg of the rows
 * (supabase_rpc) or to_json of the value (supabase_fire). Only a Postgres array
 * parameter needs its own literal (PG_ARRAY_PARAMS).
 *
 * In plain PHP, over a socket: the site's PHP has no pgsql extension, and the
 * extension's kept connections (pg_pconnect) send a RESET ALL with no time
 * limit every time they're reused — in a stall of the database (18/10: the
 * writes stuck for minutes) every php-fpm worker would hang there. Here every
 * step — connect, TLS (checked against Supabase's CA), SCRAM-SHA-256, the
 * query — has the call's time limit, and a call that runs out of it closes its
 * connection.
 *
 * Off until PG_HOST, PG_USER and PG_PASSWORD are set. Then it's the first try,
 * and PostgREST takes the call whenever this path can't: no connection (and
 * for PG_BREAKER_SECONDS after one failed), or a statement the database refuses
 * as written — a function, parameter or grant this role doesn't see (SQLSTATE
 * class 42, 22 or 0A: a migration that ran before the server's code), which is
 * logged. A timeout or an error of the database itself is NOT tried again
 * through PostgREST: that would ask the same database twice. A logging call
 * whose answer was lost may have been written: its status is 0 (no answer),
 * so it goes to the spool, whose replay never writes a hit twice.
 *
 * One connection per php-fpm worker, kept between requests (a persistent
 * socket, like the curl share): a new one costs a TLS handshake and the SCRAM
 * exchange, a kept one only the query. A kept socket that has read from the
 * server (ftell > 0) went through the whole startup in an earlier request; one
 * left in the middle of a call (a fatal error) is closed at shutdown, never
 * reused half-read.
 *
 * The role (pages_server, 20261024d) has EXECUTE on these functions and
 * nothing else; they're SECURITY DEFINER and still check p_key, as through
 * PostgREST.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** After a connection that failed, this long through PostgREST only (shared by the workers: a file's mtime). */
const PG_BREAKER_SECONDS = 30;

/** A new connection (TCP, TLS, authentication) takes at most this much of the call's time. */
const PG_CONNECT_TIMEOUT_MS = 2000;

/** A message longer than this isn't Postgres talking: the connection is dropped. */
const PG_MAX_MESSAGE = 64 * 1024 * 1024;

/** The parameters that are Postgres arrays, not jsonb: they go as an array literal. */
const PG_ARRAY_PARAMS = ['cta_content_get' => ['p_ids' => true]];

/** Supabase Root 2021 CA: it signs the pooler's certificate. */
const PG_ROOT_CA = <<<'PEM'
-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----

PEM;

/** Is this path set up (PG_HOST, PG_USER, PG_PASSWORD)? */
function pg_configured(): bool
{
    $cfg = config();
    return $cfg['pg_host'] !== '' && $cfg['pg_user'] !== '' && $cfg['pg_password'] !== '';
}

/**
 * Where to connect, from the config; null = this path is off. PG_SSLMODE is
 * verify-full (the default: TLS, the certificate checked against Supabase's
 * CA and the host name) or disable (a local database only).
 *
 * @return array{host: string, port: int, database: string, user: string, password: string, ca: ?string}|null
 */
function pg_target(): ?array
{
    static $target = false;
    if ($target !== false) {
        return $target;
    }
    if (!pg_configured()) {
        return $target = null;
    }
    $cfg = config();
    $ca = null;
    if ($cfg['pg_sslmode'] !== 'disable') {
        $ca = pg_root_ca_file();
        if ($ca === null) {
            return $target = null;
        }
    }
    return $target = [
        'host' => $cfg['pg_host'],
        'port' => $cfg['pg_port'],
        'database' => $cfg['pg_database'],
        'user' => $cfg['pg_user'],
        'password' => $cfg['pg_password'],
        'ca' => $ca,
    ];
}

/** The CA as a file for the TLS check (in the cache folder); null when it can't be written. */
function pg_root_ca_file(): ?string
{
    $file = cache_dir() . '/supabase-root-ca.crt';
    if (@file_get_contents($file) === PG_ROOT_CA) {
        return $file;
    }
    return atomic_write($file, PG_ROOT_CA) ? $file : null;
}

function pg_breaker_file(): string
{
    return cache_dir() . '/pg-breaker';
}

/** Did a connection fail in the last PG_BREAKER_SECONDS? */
function pg_breaker_open(): bool
{
    $file = pg_breaker_file();
    clearstatcache(true, $file);
    $t = @filemtime($file);
    return $t !== false && time() - $t < PG_BREAKER_SECONDS;
}

/** Turns this path off for PG_BREAKER_SECONDS; logged once per round. */
function pg_breaker_trip(string $why): void
{
    if (!pg_breaker_open()) {
        error_log("[dayone-pages] postgres: $why — through PostgREST for " . PG_BREAKER_SECONDS . ' s');
    }
    @touch(pg_breaker_file());
}

/**
 * pages.<fn>($params) straight through the pooler. $rows: a read that
 * returns rows (supabase_rpc: json_agg) — otherwise a logging call that
 * returns one value (supabase_fire: to_json). $target: the tests'.
 *
 * `fallback` = this path didn't take the call: PostgREST does. Otherwise `ok`,
 * `value` (the decoded JSON) and `status`, the HTTP status PostgREST would
 * have given: 200; 0 = no answer (timeout, connection lost); 5xx = the
 * database failed, worth trying again; 4xx = refused (log_spool_retryable).
 *
 * @return array{fallback: bool, ok?: bool, value?: mixed, status?: int, error?: string}
 */
function pg_call(string $fn, array $params, bool $rows, int $timeoutMs, ?array $target = null): array
{
    $target ??= pg_target();
    if ($target === null) {
        return ['fallback' => true];
    }
    $sql = pg_statement($fn, $params, $rows);
    if ($sql === null) {
        return ['fallback' => true];
    }
    $deadline = hrtime(true) + max(1, $timeoutMs) * 1_000_000;
    $s = pg_link($target, $deadline);
    if ($s === null) {
        return ['fallback' => true];
    }

    pg_in_flight($s);
    // Nothing reached the server: PostgREST can take the call.
    if (!pg_write($s, pg_frame('Q', $sql . "\0"), $deadline)) {
        pg_drop($s);
        return ['fallback' => true];
    }
    $value = null;
    $got = false;
    $error = null;
    while (true) {
        $m = pg_message($s, $deadline);
        if ($m === null) {
            pg_drop($s);
            return ['fallback' => false, 'ok' => false, 'status' => 0, 'error' => 'timeout'];
        }
        if ($m === false) {
            // The connection died with the call on it: a read can be asked again; a
            // write may already be in, so it's "no answer" and the spool replays it.
            pg_drop($s);
            if ($rows) {
                return ['fallback' => true];
            }
            return ['fallback' => false, 'ok' => false, 'status' => $error !== null ? pg_http_status($error[0]) : 0, 'error' => 'connection lost'];
        }
        [$type, $body] = $m;
        if ($type === 'D' && !$got) {
            $value = pg_first_column($body);
            $got = true;
        } elseif ($type === 'E') {
            $error ??= pg_error_fields($body);
        } elseif ($type === 'Z') {
            break;
        }
    }
    pg_in_flight(null);
    // A connection is only kept outside a transaction (it never is inside one: one statement each).
    if ($body !== 'I') {
        pg_drop($s);
    }

    if ($error !== null) {
        [$sqlstate, $message] = $error;
        if (pg_misfit($sqlstate)) {
            error_log("[dayone-pages] postgres refused $fn ($sqlstate: " . substr($message, 0, 200) . ') — through PostgREST');
            return ['fallback' => true];
        }
        return ['fallback' => false, 'ok' => false, 'status' => pg_http_status($sqlstate), 'error' => "SQLSTATE $sqlstate"];
    }
    $decoded = is_string($value) && $value !== '' ? json_decode($value, true) : null;
    if ($rows && !is_array($decoded)) {
        return ['fallback' => false, 'ok' => false, 'status' => 500, 'error' => 'response is not JSON'];
    }
    return ['fallback' => false, 'ok' => true, 'status' => 200, 'value' => $decoded];
}

/**
 * This worker's connection to $target, authenticated and idle; null =
 * PostgREST takes the call (breaker open, or it couldn't connect in time).
 * PHP keeps a persistent socket by its address alone: one user per host:port.
 *
 * @return resource|null
 */
function pg_link(array $target, int $deadline)
{
    if (pg_breaker_open()) {
        return null;
    }
    $connectDeadline = min($deadline, hrtime(true) + PG_CONNECT_TIMEOUT_MS * 1_000_000);
    $seconds = ($connectDeadline - hrtime(true)) / 1e9;
    if ($seconds <= 0) {
        return null;
    }
    $context = stream_context_create(['ssl' => [
        'verify_peer' => true,
        'verify_peer_name' => true,
        'peer_name' => $target['host'],
        'cafile' => (string) $target['ca'],
        'SNI_enabled' => true,
        'disable_compression' => true,
    ]]);
    $s = @stream_socket_client(
        "tcp://{$target['host']}:{$target['port']}",
        $errno,
        $errstr,
        $seconds,
        STREAM_CLIENT_CONNECT | STREAM_CLIENT_PERSISTENT,
        $context,
    );
    if ($s === false) {
        pg_breaker_trip("can't connect to {$target['host']}:{$target['port']} ($errstr)");
        return null;
    }
    stream_set_blocking($s, false);
    // Kept from an earlier request, which read the server's answers up to "ready".
    if (ftell($s) > 0 && ($target['ca'] === null || isset(stream_get_meta_data($s)['crypto']))) {
        return $s;
    }
    pg_in_flight($s);
    $failure = pg_startup($s, $target, $connectDeadline);
    pg_in_flight(null);
    if ($failure !== null) {
        pg_drop($s);
        pg_breaker_trip($failure);
        return null;
    }
    return $s;
}

/**
 * A new connection up to "ready for query": TLS when there's a CA, the
 * startup message, SCRAM-SHA-256 (the server must prove it knows the password
 * too). Null, or why it failed.
 *
 * @param resource $s
 */
function pg_startup($s, array $target, int $deadline): ?string
{
    if ($target['ca'] !== null) {
        if (!pg_write($s, pack('NN', 8, 80877103), $deadline)) {
            return 'the TLS request was not sent';
        }
        if (pg_read($s, 1, $deadline) !== 'S') {
            return 'the server refused TLS';
        }
        while (($done = @stream_socket_enable_crypto($s, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) === 0) {
            if (!pg_wait($s, false, $deadline)) {
                return 'TLS out of time';
            }
        }
        if ($done !== true) {
            $why = (string) (error_get_last()['message'] ?? '');
            return 'TLS failed' . ($why !== '' ? ': ' . substr($why, 0, 200) : '');
        }
    }
    $startup = "user\0{$target['user']}\0database\0{$target['database']}\0application_name\0dayone-pages\0client_encoding\0UTF8\0\0";
    if (!pg_write($s, pack('NN', strlen($startup) + 8, 196608) . $startup, $deadline)) {
        return 'the startup was not sent';
    }
    $scram = null;
    $proven = false;
    while (true) {
        $m = pg_message($s, $deadline);
        if ($m === null) {
            return 'the startup ran out of time';
        }
        if ($m === false) {
            return 'the server closed the connection during the startup';
        }
        [$type, $body] = $m;
        if ($type === 'E') {
            [$sqlstate, $message] = pg_error_fields($body);
            return "refused ($sqlstate: " . substr($message, 0, 200) . ')';
        }
        if ($type === 'Z') {
            return $proven ? null : 'ready without SCRAM';
        }
        if ($type !== 'R' || strlen($body) < 4) {
            continue; // ParameterStatus, BackendKeyData, a notice
        }
        $code = unpack('N', $body)[1];
        $data = substr($body, 4);
        if ($code === 10) {
            if (!in_array('SCRAM-SHA-256', explode("\0", $data), true)) {
                return 'the server offers no SCRAM-SHA-256';
            }
            [$first, $scram] = pg_scram_first();
            $sent = pg_write($s, pg_frame('p', "SCRAM-SHA-256\0" . pack('N', strlen($first)) . $first), $deadline);
        } elseif ($code === 11 && $scram !== null) {
            $final = pg_scram_final($scram, $data, $target['password']);
            if ($final === null) {
                return 'an invalid SCRAM challenge';
            }
            [$message, $scram] = $final;
            $sent = pg_write($s, pg_frame('p', $message), $deadline);
        } elseif ($code === 12 && $scram !== null) {
            if (!pg_scram_verify($scram, $data)) {
                return "the server's SCRAM signature doesn't match";
            }
            $proven = true;
            $sent = true;
        } elseif ($code === 0) {
            $sent = true;
        } else {
            return "authentication method $code not supported";
        }
        if (!$sent) {
            return 'the authentication was not sent';
        }
    }
}

/**
 * The socket a call is using (null: none). One left in the middle of a call
 * when the request ends — a fatal error — is closed, never reused half-read.
 *
 * @param resource|null $s
 */
function pg_in_flight($s): void
{
    static $current = null;
    static $registered = false;
    $current = $s;
    if (!$registered) {
        $registered = true;
        register_shutdown_function(static function () use (&$current): void {
            if (is_resource($current)) {
                @fclose($current);
            }
        });
    }
}

/** Closes the connection for good (a persistent socket too): the next call opens a new one. */
function pg_drop($s): void
{
    pg_in_flight(null);
    if (is_resource($s)) {
        @fclose($s);
    }
}

/** A message to the server: its type, its length, its body. */
function pg_frame(string $type, string $body): string
{
    return $type . pack('N', strlen($body) + 4) . $body;
}

/** @param resource $s */
function pg_write($s, string $data, int $deadline): bool
{
    while ($data !== '') {
        $n = @fwrite($s, $data);
        if ($n === false) {
            return false;
        }
        if ($n > 0) {
            $data = substr($data, $n);
        } elseif (!pg_wait($s, true, $deadline)) {
            return false;
        }
    }
    return true;
}

/**
 * Exactly $n bytes; null = out of time, false = the connection closed.
 *
 * @param resource $s
 */
function pg_read($s, int $n, int $deadline): string|false|null
{
    $buf = '';
    while (strlen($buf) < $n) {
        $chunk = @fread($s, $n - strlen($buf));
        if ($chunk === false) {
            return false;
        }
        if ($chunk !== '') {
            $buf .= $chunk;
            continue;
        }
        if (feof($s)) {
            return false;
        }
        if (!pg_wait($s, false, $deadline)) {
            return hrtime(true) >= $deadline ? null : false;
        }
    }
    return $buf;
}

/**
 * Waits until $s can be read (or written): false = out of time.
 *
 * @param resource $s
 */
function pg_wait($s, bool $write, int $deadline): bool
{
    $leftUs = intdiv($deadline - hrtime(true), 1000);
    if ($leftUs <= 0) {
        return false;
    }
    $read = $write ? null : [$s];
    $writeSet = $write ? [$s] : null;
    $except = null;
    return @stream_select($read, $writeSet, $except, intdiv($leftUs, 1_000_000), $leftUs % 1_000_000) > 0;
}

/**
 * The server's next message, [type, body]; null = out of time, false = the
 * connection closed (or what came isn't Postgres).
 *
 * @param resource $s
 * @return array{0: string, 1: string}|false|null
 */
function pg_message($s, int $deadline): array|false|null
{
    $head = pg_read($s, 5, $deadline);
    if (!is_string($head)) {
        return $head;
    }
    $length = unpack('N', substr($head, 1))[1] - 4;
    if ($length < 0 || $length > PG_MAX_MESSAGE) {
        return false;
    }
    $body = $length > 0 ? pg_read($s, $length, $deadline) : '';
    return is_string($body) ? [$head[0], $body] : $body;
}

/** A DataRow's first column: its text, or null (SQL NULL). */
function pg_first_column(string $body): ?string
{
    if (strlen($body) < 6 || unpack('n', $body)[1] < 1) {
        return null;
    }
    $length = unpack('N', substr($body, 2, 4))[1];
    return $length === 0xFFFFFFFF ? null : substr($body, 6, $length);
}

/**
 * An ErrorResponse's SQLSTATE and message.
 *
 * @return array{0: string, 1: string}
 */
function pg_error_fields(string $body): array
{
    $fields = [];
    foreach (explode("\0", $body) as $field) {
        if ($field !== '') {
            $fields[$field[0]] = substr($field, 1);
        }
    }
    return [$fields['C'] ?? '', $fields['M'] ?? ''];
}

/**
 * SCRAM-SHA-256's first message (no channel binding; Postgres takes the user
 * from the startup message, so the name here is empty) and the state for the
 * next steps. $nonce and $user: the RFC's test vector.
 *
 * @return array{0: string, 1: array{nonce: string, bare: string}}
 */
function pg_scram_first(?string $nonce = null, string $user = ''): array
{
    $nonce ??= rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
    $bare = "n=$user,r=$nonce";
    return ["n,,$bare", ['nonce' => $nonce, 'bare' => $bare]];
}

/**
 * The answer to the server's challenge (r=…,s=…,i=…) with the proof, and what
 * the server's last message must carry; null = not a valid challenge.
 *
 * @return array{0: string, 1: array{signature: string}}|null
 */
function pg_scram_final(array $state, string $challenge, string $password): ?array
{
    $attrs = [];
    foreach (explode(',', $challenge) as $part) {
        if (strlen($part) > 2 && $part[1] === '=') {
            $attrs[$part[0]] = substr($part, 2);
        }
    }
    $nonce = $attrs['r'] ?? '';
    $salt = base64_decode($attrs['s'] ?? '', true);
    $iterations = (int) ($attrs['i'] ?? 0);
    if (!str_starts_with($nonce, $state['nonce']) || strlen($nonce) === strlen($state['nonce'])
        || $salt === false || $salt === '' || $iterations < 1) {
        return null;
    }
    $salted = hash_pbkdf2('sha256', $password, $salt, $iterations, 32, true);
    $clientKey = hash_hmac('sha256', 'Client Key', $salted, true);
    $withoutProof = 'c=biws,r=' . $nonce;
    $auth = $state['bare'] . ',' . $challenge . ',' . $withoutProof;
    $proof = $clientKey ^ hash_hmac('sha256', $auth, hash('sha256', $clientKey, true), true);
    $serverKey = hash_hmac('sha256', 'Server Key', $salted, true);
    return [
        $withoutProof . ',p=' . base64_encode($proof),
        ['signature' => base64_encode(hash_hmac('sha256', $auth, $serverKey, true))],
    ];
}

/** Does the server's last message (v=…) prove it knows the password too? */
function pg_scram_verify(array $state, string $final): bool
{
    return hash_equals('v=' . $state['signature'], $final);
}

/**
 * The statement for pages.<fn>($params), or null when a name isn't a plain
 * identifier or a value can't be written (PostgREST decides).
 */
function pg_statement(string $fn, array $params, bool $rows): ?string
{
    $name = '/^[a-z_][a-z0-9_]*$/';
    if (!preg_match($name, $fn)) {
        return null;
    }
    $args = [];
    foreach ($params as $param => $value) {
        if (!is_string($param) || !preg_match($name, $param)) {
            return null;
        }
        $literal = pg_literal($value, isset(PG_ARRAY_PARAMS[$fn][$param]));
        if ($literal === false) {
            return null;
        }
        $args[] = "$param => $literal";
    }
    $call = 'pages.' . $fn . '(' . implode(', ', $args) . ')';
    // The rows through a subquery: a one-column TABLE function still gives objects, as PostgREST does.
    // A void function's value would be "" (plpgsql): NULL instead, PostgREST's 204.
    return $rows
        ? "SELECT coalesce(json_agg(r), '[]'::json) FROM (SELECT * FROM $call) r"
        : "SELECT CASE WHEN pg_typeof(v) = 'void'::regtype THEN NULL ELSE to_json(v) END FROM (SELECT $call AS v) r";
}

/**
 * A value as an escaped string constant (E'…' — the same whatever
 * standard_conforming_strings says) whose type is still unknown, so Postgres
 * reads it as the function's own parameter type; NULL; false = can't be
 * written. An array is JSON (the parameter is jsonb), or a Postgres array
 * literal when $pgArray.
 */
function pg_literal(mixed $value, bool $pgArray = false): string|false
{
    $text = match (true) {
        $value === null => null,
        is_bool($value) => $value ? 't' : 'f',
        is_int($value), is_float($value) => (string) $value,
        is_string($value) => $value,
        is_array($value) && $pgArray => pg_array_literal($value),
        is_array($value) => json_encode($value),
        default => false,
    };
    if ($text === false) {
        return false;
    }
    if ($text === null) {
        return 'NULL';
    }
    // Postgres text can't hold a NUL byte.
    return "E'" . str_replace(['\\', "'", "\0"], ['\\\\', "''", ''], $text) . "'";
}

/** {"a","b"}: each item quoted, with " and \ escaped; false for an item that isn't a scalar. */
function pg_array_literal(array $list): string|false
{
    $items = [];
    foreach ($list as $item) {
        if ($item === null) {
            $items[] = 'NULL';
            continue;
        }
        if (!is_scalar($item)) {
            return false;
        }
        $text = is_bool($item) ? ($item ? 't' : 'f') : (string) $item;
        $items[] = '"' . addcslashes($text, '"\\') . '"';
    }
    return '{' . implode(',', $items) . '}';
}

/**
 * The statement doesn't fit the database as it is now — a function,
 * parameter or grant this role doesn't see, a value of the wrong shape, a
 * feature not there: PostgREST, which knows the schema, takes the call.
 */
function pg_misfit(string $sqlstate): bool
{
    return in_array(substr($sqlstate, 0, 2), ['42', '22', '0A'], true);
}

/** A database error as the HTTP status PostgREST gives it (only what the callers tell apart). */
function pg_http_status(string $sqlstate): int
{
    $class = substr($sqlstate, 0, 2);
    return match (true) {
        // Refusals, never worth trying again: a key that isn't ours (pages.server_key_ok raises 28000,
        // which PostgREST answers 403), a RAISE in the function, a constraint.
        $class === '28' => 403,
        $sqlstate === 'P0001' => 400,
        $class === '23' => 409,
        // The database can't now (connections, timeouts, locks, shutdown): worth trying again.
        in_array($class, ['08', '40', '53', '55', '57', '58'], true) => 503,
        default => 500,
    };
}
