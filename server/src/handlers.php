<?php
/**
 * Internal endpoints: /_health, /_purge, /_dop/version and /_dop/health.
 *
 * /_health doesn't depend on Supabase — it's liveness. It returns the
 * X-DayOne-Pages marker (SERVER_ID), which is how the dashboard confirms that
 * a domain reached this server.
 *
 * /_dop/version (24/10) says which code is running: the commit build-dropin.sh
 * recorded in VERSION, the server files that differed from it, and whether a
 * file changed after the build. Public, like /_health: the repo is too.
 *
 * /_dop/health (24/10) is the server's state for a monitor, with HEALTH_TOKEN
 * (X-Health-Token or Authorization: Bearer; none configured or a wrong one =
 * 404): the spools, the local tables, the cache's disk, the Supabase breaker
 * and the error log's last lines. 200 when nothing is wrong, 503 with the
 * problems otherwise.
 *
 * /_purge deletes a host's routes entries (or everything). POST only, with
 * X-Purge-Token compared in constant time — or, for one host, signed
 * (09/10): X-Purge-Signature = HMAC-SHA256 of "host|unix time" with
 * PURGE_TOKEN and X-Purge-Time = that time, valid for PURGE_SIGNATURE_WINDOW.
 * The database signs it (pages.purge_request, the token kept in Vault) and the
 * dashboards send it to https://<host>/_purge — this server answers /_purge
 * on every domain it serves —, so the token itself never travels: a domain
 * whose DNS no longer points here only ever sees a signature that purges that
 * host's cache for 2 minutes. With no token configured or a wrong token or
 * signature it answers 404, not 401: it doesn't confirm the route exists.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

function handle_health(Request $req): array
{
    $cfg = config();
    $body = json_encode([
        'ok' => true,
        'server_id' => $cfg['server_id'],
        'cache_writable' => cache_writable(),
        'time' => gmdate('c'),
    ]);
    return [200, [
        'Content-Type' => 'application/json; charset=utf-8',
        'Cache-Control' => 'no-store',
        'X-DayOne-Pages' => $cfg['server_id'],
    ], (string) $body];
}

/** How far (seconds, either way) a signed purge's time may be from this server's clock. */
const PURGE_SIGNATURE_WINDOW = 120;

/** A signed purge for $host: HMAC-SHA256 of "host|time" with the purge token, the time within the window. */
function purge_signature_ok(string $host, ?string $time, ?string $signature, string $token, int $now): bool
{
    if ($token === '' || $time === null || $signature === null || !ctype_digit($time)) {
        return false;
    }
    if (abs($now - (int) $time) > PURGE_SIGNATURE_WINDOW) {
        return false;
    }
    return hash_equals(hash_hmac('sha256', "$host|$time", $token), strtolower(trim($signature)));
}

/** $rawBody: the request body (null = php://input; the tests pass it). */
function handle_purge(Request $req, ?string $rawBody = null): array
{
    $cfg = config();
    $notFound = [404, ['Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store'], "Not found\n"];

    if ($req->method !== 'POST' || $cfg['purge_token'] === '') {
        return $notFound;
    }
    $byToken = $req->purgeToken !== null && hash_equals($cfg['purge_token'], $req->purgeToken);
    if (!$byToken && $req->purgeSignature === null) {
        return $notFound;
    }

    $raw = $rawBody ?? (string) file_get_contents('php://input');
    $input = json_decode($raw === '' ? '{}' : $raw, true);
    if (!is_array($input)) {
        return $byToken ? [400, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], '{"error":"invalid body"}'] : $notFound;
    }

    // Everything only with the token itself; a signature purges one host.
    if (!empty($input['all'])) {
        if (!$byToken) {
            return $notFound;
        }
        $n = purge_all();
        return [200, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], json_encode(['purged' => $n, 'scope' => 'all'])];
    }

    $host = normalize_host((string) ($input['host'] ?? ''));
    if (!$byToken && !purge_signature_ok($host, $req->purgeTime, $req->purgeSignature, $cfg['purge_token'], time())) {
        return $notFound;
    }
    if (!is_valid_host($host)) {
        return [400, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], '{"error":"invalid host"}'];
    }
    $n = purge_host($host);
    // The VSLs' CTA blocks (cta.php) are kept per page, not per host: all of them are asked again.
    cta_draw_purge();
    return [200, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], json_encode(['purged' => $n, 'host' => $host])];
}

// ── /_dop/version: which code is running ─────────────────────────────────────

const VERSION_PATH = '/_dop/version';
/** Next to the code, written by build-dropin.sh: what the folder was built from. */
const VERSION_FILE = 'VERSION';

/**
 * The code on disk: sha256 over every *.php in $dir, name and content, in name
 * order. build-dropin.sh records it in VERSION; a different one now means a
 * file was changed by hand after the build.
 */
function code_sha(string $dir): string
{
    $files = glob(rtrim($dir, '/') . '/*.php') ?: [];
    sort($files, SORT_STRING);
    $ctx = hash_init('sha256');
    foreach ($files as $file) {
        hash_update($ctx, basename($file) . "\0" . (string) hash_file('sha256', $file) . "\n");
    }
    return hash_final($ctx);
}

/**
 * The build's commit and branch, the server files that differed from that
 * commit (a deploy from a tree with uncommitted work), when it was built, the
 * code's sha now and whether it changed since. Run from the repo (no VERSION):
 * commit null.
 */
function version_info(string $dir = __DIR__): array
{
    $raw = @file_get_contents(rtrim($dir, '/') . '/' . VERSION_FILE);
    $built = is_string($raw) ? json_decode($raw, true) : null;
    $built = is_array($built) ? $built : [];
    $text = static fn(string $key): ?string => is_string($built[$key] ?? null) && $built[$key] !== '' ? $built[$key] : null;
    $sha = code_sha($dir);
    return [
        'commit' => $text('commit'),
        'branch' => $text('branch'),
        'uncommitted' => is_array($built['uncommitted'] ?? null) ? array_values(array_filter($built['uncommitted'], 'is_string')) : [],
        'built_at' => $text('built_at'),
        'code_sha' => $sha,
        'changed_since_build' => $text('code_sha') !== null ? !hash_equals($text('code_sha'), $sha) : null,
    ];
}

function handle_version(): array
{
    return [200, [
        'Content-Type' => 'application/json; charset=utf-8',
        'Cache-Control' => 'no-store',
    ], (string) json_encode(version_info(), JSON_UNESCAPED_SLASHES)];
}

// ── /_dop/health: the server's state, for a monitor ──────────────────────────

const HEALTH_PATH = '/_dop/health';
/** A spool item older than this (seconds) means its replay isn't draining it. */
const HEALTH_SPOOL_STALE = 900;
/** The local tables rebuild once a day; older than this (seconds), the rebuild is failing. */
const HEALTH_TABLE_STALE = 2 * 86400;
/** Less free space than this (bytes) on the cache's disk. */
const HEALTH_DISK_MIN = 2 * 1024 * 1024 * 1024;
/** The error log's last lines in the answer, each cut to this many bytes. */
const HEALTH_LOG_LINES = 20;
const HEALTH_LOG_LINE_BYTES = 400;

/** The token a monitor sent: X-Health-Token, or Authorization: Bearer. */
function health_token_from(array $server): ?string
{
    if (isset($server['HTTP_X_HEALTH_TOKEN'])) {
        return (string) $server['HTTP_X_HEALTH_TOKEN'];
    }
    if (preg_match('~^Bearer\s+(\S+)$~i', (string) ($server['HTTP_AUTHORIZATION'] ?? ''), $m) === 1) {
        return $m[1];
    }
    return null;
}

/** How long ago a file was modified, in seconds; null when it doesn't exist. */
function health_file_age(string $path, int $now): ?int
{
    clearstatcache(true, $path);
    $t = @filemtime($path);
    return $t === false ? null : max(0, $now - $t);
}

/** A spool: its size and how old its first item is (items are appended, so the oldest). */
function health_spool(string $path, int $now): array
{
    clearstatcache(true, $path);
    if (!is_file($path)) {
        return ['bytes' => 0, 'oldest_age_s' => null];
    }
    $age = null;
    $fh = @fopen($path, 'r');
    if ($fh !== false) {
        $line = fgets($fh);
        fclose($fh);
        $item = is_string($line) ? json_decode($line, true) : null;
        if (is_array($item) && is_numeric($item['at'] ?? null)) {
            $age = max(0, $now - (int) $item['at']);
        }
    }
    return ['bytes' => (int) @filesize($path), 'oldest_age_s' => $age];
}

/** How long ago a local table (netdb, rirdb, anondb) was built, from its meta.json; null = never. */
function health_table_age(string $dir, int $now): ?int
{
    $raw = @file_get_contents(rtrim($dir, '/') . '/meta.json');
    $meta = is_string($raw) ? json_decode($raw, true) : null;
    return is_array($meta) && is_int($meta['built_at'] ?? null) ? max(0, $now - $meta['built_at']) : null;
}

/** The last $lines lines of a log, read from its last 64 KB. */
function health_log_tail(string $path, int $lines = HEALTH_LOG_LINES): array
{
    $size = $path === '' ? false : @filesize($path);
    if ($size === false || $size === 0) {
        return [];
    }
    $fh = @fopen($path, 'r');
    if ($fh === false) {
        return [];
    }
    $len = min($size, 65536);
    fseek($fh, -$len, SEEK_END);
    $chunk = (string) fread($fh, $len);
    fclose($fh);
    $all = preg_split('/\R/', rtrim($chunk)) ?: [];
    if ($len < $size) {
        array_shift($all); // the first one may start mid-line
    }
    return array_map(
        static fn(string $l): string => strlen($l) > HEALTH_LOG_LINE_BYTES ? substr($l, 0, HEALTH_LOG_LINE_BYTES) . '…' : $l,
        array_slice($all, -$lines)
    );
}

/**
 * The server's state and what is wrong with it: `problems` (the monitor's 503)
 * and `warnings` (worth knowing, not an outage). $tables: name → folder of
 * each local table, and $now: the tests'.
 */
function health_report(?array $tables = null, ?int $now = null): array
{
    $now ??= time();
    $problems = [];
    $warnings = [];

    $version = version_info();
    if ($version['changed_since_build'] === true) {
        $warnings['code'] = 'a file changed after the build';
    }
    if ($version['uncommitted'] !== []) {
        $warnings['uncommitted'] = 'built with uncommitted changes: ' . implode(', ', $version['uncommitted']);
    }

    $writable = cache_writable();
    if (!$writable) {
        $problems['cache'] = 'the cache folder is not writable';
    }
    $free = @disk_free_space(cache_dir());
    if (is_float($free) && $free < HEALTH_DISK_MIN) {
        $problems['disk'] = sprintf('%.1f GB free on the cache disk', $free / 1024 ** 3);
    }

    $spools = [
        'log' => health_spool(log_spool_path(), $now) + ['replaying_age_s' => health_file_age(log_spool_path(LOG_SPOOL_WORK), $now)],
        'dot' => health_spool(dot_spool_path(), $now),
    ];
    foreach ($spools as $name => $spool) {
        if (($spool['oldest_age_s'] ?? 0) > HEALTH_SPOOL_STALE) {
            $problems["{$name}_spool"] = sprintf('%s spool not draining: oldest item %d min old', $name, intdiv($spool['oldest_age_s'], 60));
        }
    }
    if (($spools['log']['replaying_age_s'] ?? 0) > HEALTH_SPOOL_STALE) {
        $problems['log_spool_replay'] = sprintf('a log spool replay stopped %d min ago and never finished', intdiv($spools['log']['replaying_age_s'], 60));
    }

    $tables ??= ['netdb' => netdb_dir(), 'rirdb' => rirdb_dir(), 'anondb' => anondb_dir()];
    $tableAges = [];
    foreach ($tables as $name => $dir) {
        $age = health_table_age($dir, $now);
        $tableAges[$name] = $age;
        if ($age === null) {
            $problems[$name] = "$name never built";
        } elseif ($age > HEALTH_TABLE_STALE) {
            $problems[$name] = sprintf('%s built %d h ago (rebuilt daily)', $name, intdiv($age, 3600));
        }
    }

    // The breaker's file is touched when a refresh fails and removed when one succeeds (resolver.php).
    $failureAge = health_file_age(supabase_breaker_file(), $now);
    $breakerOpen = $failureAge !== null && $failureAge < SUPABASE_BREAKER_SECONDS;
    if ($breakerOpen) {
        $problems['supabase'] = 'a refresh from Supabase failed in the last ' . SUPABASE_BREAKER_SECONDS . ' s';
    }

    $errorLog = (string) ini_get('error_log');
    $load = function_exists('sys_getloadavg') ? sys_getloadavg() : false;

    return [
        'ok' => $problems === [],
        'problems' => $problems,
        'warnings' => $warnings,
        'time' => gmdate('c', $now),
        'server_id' => config()['server_id'],
        'version' => $version,
        'php' => PHP_VERSION,
        'load' => is_array($load) ? array_map(static fn($x): float => round((float) $x, 2), $load) : null,
        'cache' => ['writable' => $writable, 'disk_free_gb' => is_float($free) ? round($free / 1024 ** 3, 1) : null],
        'spools' => $spools,
        'tables_age_s' => $tableAges,
        'supabase' => ['breaker_open' => $breakerOpen, 'last_failure_age_s' => $failureAge],
        'error_log' => [
            'bytes' => $errorLog !== '' ? (int) @filesize($errorLog) : null,
            'age_s' => $errorLog !== '' ? health_file_age($errorLog, $now) : null,
            'last' => health_log_tail($errorLog),
        ],
    ];
}

/** $given: the token the request carried; $expected: HEALTH_TOKEN (empty = the endpoint is off). */
function handle_dop_health(?string $given, string $expected, ?array $report = null): array
{
    if ($expected === '' || $given === null || !hash_equals($expected, $given)) {
        return [404, ['Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store'], "Not found\n"];
    }
    $report ??= health_report();
    return [$report['ok'] ? 200 : 503, [
        'Content-Type' => 'application/json; charset=utf-8',
        'Cache-Control' => 'no-store',
    ], (string) json_encode($report, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)];
}
