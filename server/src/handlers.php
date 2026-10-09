<?php
/**
 * Internal endpoints: /_health and /_purge.
 *
 * /_health doesn't depend on Supabase — it's liveness. It returns the
 * X-DayOne-Pages marker (SERVER_ID), which is how the dashboard confirms that
 * a domain reached this server.
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
    return [200, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], json_encode(['purged' => $n, 'host' => $host])];
}
