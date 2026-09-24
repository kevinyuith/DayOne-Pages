<?php
/**
 * Internal endpoints: /_health and /_purge.
 *
 * /_health doesn't depend on Supabase — it's liveness. It returns the
 * X-DayOne-Pages marker (SERVER_ID), which is how the dashboard confirms that
 * a domain reached this server.
 *
 * /_purge deletes a host's routes entries (or everything). POST only, with
 * X-Purge-Token compared in constant time. With no token configured or a
 * wrong token it answers 404, not 401: it doesn't confirm the route exists.
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

function handle_purge(Request $req): array
{
    $cfg = config();
    $notFound = [404, ['Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store'], "Not found\n"];

    if ($req->method !== 'POST') {
        return $notFound;
    }
    if ($cfg['purge_token'] === '' || $req->purgeToken === null || !hash_equals($cfg['purge_token'], $req->purgeToken)) {
        return $notFound;
    }

    $raw = (string) file_get_contents('php://input');
    $input = json_decode($raw === '' ? '{}' : $raw, true);
    if (!is_array($input)) {
        return [400, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], '{"error":"invalid body"}'];
    }

    if (!empty($input['all'])) {
        $n = purge_all();
        return [200, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], json_encode(['purged' => $n, 'scope' => 'all'])];
    }

    $host = normalize_host((string) ($input['host'] ?? ''));
    if (!is_valid_host($host)) {
        return [400, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], '{"error":"invalid host"}'];
    }
    $n = purge_host($host);
    return [200, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], json_encode(['purged' => $n, 'host' => $host])];
}
