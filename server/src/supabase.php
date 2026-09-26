<?php
/**
 * The Supabase calls: POST /rest/v1/rpc/resolve (the routes for a host +
 * path, with only each content's hash) and /rpc/content_get (the HTML of the
 * pages whose hash the disk doesn't have yet), plus the logging ones (log_*).
 *
 * They go with the publishable (anon) key and with THIS server's key
 * (PAGES_SERVER_KEY), whose hash lives in pages.server_keys. The functions in
 * the database are SECURITY DEFINER. The service key never reaches this machine.
 *
 * `Content-Profile: pages` because the function doesn't live in the `public` schema.
 * Invalid key → 403 from PostgREST → we treat it as an error (never as a negative
 * 404, otherwise a rotated key would take down every site until the negative cache expired).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/**
 * The routes for (host, path), without the HTML: `content_hash` is the sha256
 * of each slug's HTML, fetched separately by supabase_content_get.
 *
 * @return array{ok: bool, routes?: array, error?: string, status?: int}
 */
function supabase_resolve(string $host, string $path): array
{
    $r = supabase_rpc('resolve', ['p_host' => $host, 'p_path' => $path, 'p_with_content' => false]);
    return $r['ok'] ? ['ok' => true, 'routes' => $r['rows']] : $r;
}

/** Requests per content_get call (the database refuses more than 50). */
const CONTENT_GET_BATCH = 50;

/**
 * The HTML of each requested (page, slug), in batches, with the hash the
 * database has now (it may be newer than the resolve's, if the page changed in
 * between). A request the database doesn't have simply doesn't come back.
 *
 * @param list<array{page_id: string, slug: string}> $refs
 * @return array{ok: bool, contents?: list<array{page_id: string, slug: string, content_hash: string, content: string}>, error?: string, status?: int}
 */
function supabase_content_get(array $refs): array
{
    $contents = [];
    foreach (array_chunk(array_values($refs), CONTENT_GET_BATCH) as $batch) {
        $r = supabase_rpc('content_get', ['p_refs' => $batch]);
        if (!$r['ok']) {
            return $r;
        }
        foreach ($r['rows'] as $row) {
            if (is_array($row) && is_string($row['page_id'] ?? null) && is_string($row['slug'] ?? null)
                && is_string($row['content_hash'] ?? null) && is_string($row['content'] ?? null)) {
                $contents[] = $row;
            }
        }
    }
    return ['ok' => true, 'contents' => $contents];
}

/**
 * POST to a read RPC (pages.<fn>) with p_key; returns the rows.
 *
 * @return array{ok: bool, rows?: array, error?: string, status?: int}
 */
function supabase_rpc(string $fn, array $params): array
{
    $cfg = config();
    if ($cfg['supabase_url'] === '' || $cfg['supabase_anon_key'] === '' || $cfg['server_key'] === '') {
        return ['ok' => false, 'error' => 'SUPABASE_URL, SUPABASE_ANON_KEY or PAGES_SERVER_KEY missing'];
    }

    $body = json_encode($params + ['p_key' => $cfg['server_key']]);
    if ($body === false) {
        return ['ok' => false, 'error' => 'json_encode'];
    }

    $ch = curl_init($cfg['supabase_url'] . '/rest/v1/rpc/' . $fn);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => max(1, $cfg['supabase_timeout']),
        CURLOPT_HTTPHEADER => [
            'apikey: ' . $cfg['supabase_anon_key'],
            'Authorization: Bearer ' . $cfg['supabase_anon_key'],
            'Content-Type: application/json',
            'Content-Profile: pages',
            'Accept: application/json',
        ],
    ]);

    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    // No curl_close(): it's a no-op since PHP 8.0 and deprecated in 8.5.

    if ($raw === false) {
        return ['ok' => false, 'error' => 'curl: ' . $err];
    }
    if ($status !== 200) {
        // Never logs the body with the key; the status is enough to diagnose.
        return ['ok' => false, 'error' => "HTTP $status", 'status' => $status];
    }

    $rows = json_decode((string) $raw, true);
    if (!is_array($rows)) {
        return ['ok' => false, 'error' => 'response is not JSON'];
    }

    return ['ok' => true, 'rows' => array_values($rows)];
}

/**
 * Stores a hit: POST /rest/v1/rpc/log_hit. Same door as resolve (anon +
 * server key). Never takes down the response to the visitor; a failure only
 * goes to the log. Must be called AFTER fastcgi_finish_request. Returns the
 * new hit's id (null: not logged, or the call failed).
 *
 * @param array<string,mixed> $params already with the p_* keys (except p_key)
 */
function supabase_log_hit(array $params): ?int
{
    $id = supabase_fire('log_hit', $params);
    return is_int($id) || (is_string($id) && ctype_digit($id)) ? (int) $id : null;
}

/** The network lookups of a hit already written (log_hit_net). */
function supabase_log_hit_net(int $id, ?int $asn, ?string $asName, ?string $hostname): void
{
    supabase_fire('log_hit_net', ['p_id' => $id, 'p_asn' => $asn, 'p_as_name' => $asName, 'p_hostname' => $hostname]);
}

/** A visit's load notice (beacon.php): true = on its hit, false = no hit yet, null = the call failed. */
function supabase_log_load(string $visitId, ?int $loadMs): ?bool
{
    $found = supabase_fire('log_load', ['p_visit_id' => $visitId, 'p_load_ms' => $loadMs]);
    return is_bool($found) ? $found : null;
}

/** A visit's click notice: same as supabase_log_load. */
function supabase_log_click(string $visitId): ?bool
{
    $found = supabase_fire('log_click', ['p_visit_id' => $visitId]);
    return is_bool($found) ? $found : null;
}

/** How long the visit's page stayed open (the longest report wins): same as supabase_log_load. */
function supabase_log_duration(string $visitId, int $ms): ?bool
{
    $found = supabase_fire('log_duration', ['p_visit_id' => $visitId, 'p_ms' => $ms]);
    return is_bool($found) ? $found : null;
}

/** A visit's first interaction (mouse, scroll, touch, key): same as supabase_log_load. */
function supabase_log_interact(string $visitId, string $kind, ?int $ms): ?bool
{
    $found = supabase_fire('log_interact', ['p_visit_id' => $visitId, 'p_kind' => $kind, 'p_ms' => $ms]);
    return is_bool($found) ? $found : null;
}

/**
 * POST to a logging RPC (pages.<fn>) with p_key: the function's result
 * (decoded JSON), or null when the call failed (only the log sees it).
 */
function supabase_fire(string $fn, array $params): mixed
{
    $cfg = config();
    if ($cfg['supabase_url'] === '' || $cfg['supabase_anon_key'] === '' || $cfg['server_key'] === '') {
        return null;
    }

    $body = json_encode(['p_key' => $cfg['server_key']] + $params);
    if ($body === false) {
        return null;
    }

    $ch = curl_init($cfg['supabase_url'] . '/rest/v1/rpc/' . $fn);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => max(2, (int) $cfg['hits_timeout']),
        CURLOPT_HTTPHEADER => [
            'apikey: ' . $cfg['supabase_anon_key'],
            'Authorization: Bearer ' . $cfg['supabase_anon_key'],
            'Content-Type: application/json',
            'Content-Profile: pages',
        ],
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    if ($raw === false || ($status !== 200 && $status !== 204)) {
        error_log("[dayone-pages] $fn failed (HTTP $status)");
        return null;
    }
    return is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
}
