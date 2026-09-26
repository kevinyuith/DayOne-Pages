<?php
/**
 * The flow of a request, end to end.
 *
 *   /_health, /_purge      → internal handlers
 *   /_dop/l                → browser load notice (beacon.php)
 *   method ∉ {GET, HEAD}   → 405
 *   invalid host           → 404 (no cache, no Supabase)
 *   path too long          → 404 (same)
 *   resolver               → HIT | MISS | STALE | UPDATING | null (503)
 *   decide                 → SERVE | REDIRECT | BLOCK | 404
 *   page served on www.    → 302 to non-www with sub0 (sub0.php)
 *   HTML page served       → dop_v cookie + load notice script
 *
 * X-Cache is only sent with DEBUG_HEADERS=1. On HEAD the body is not sent.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

function dayone_handle(): void
{
    $req = parse_request($_SERVER);
    $cfg = config();

    if ($req->rawPath === '/_health') {
        [$status, $headers, $body] = handle_health($req);
        send_response($status, $headers, $body, $req->isHead());
        return;
    }
    if ($req->rawPath === BEACON_PATH) {
        [$status, $headers, $body, $visitId, $notice] = handle_beacon($req, (string) file_get_contents('php://input', false, null, 0, 256));
        send_response($status, $headers, $body, false);
        if ($visitId !== null) {
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            // On the hit (pages.hits); retried while the hit isn't written yet.
            beacon_record(static fn () => beacon_send($visitId, $notice));
        }
        return;
    }
    if ($req->rawPath === '/_purge') {
        [$status, $headers, $body] = handle_purge($req);
        send_response($status, $headers, $body, false);
        return;
    }

    if ($req->method !== 'GET' && $req->method !== 'HEAD') {
        send_response(405, ['Allow' => 'GET, HEAD', 'Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store'], "Method not allowed\n", false);
        return;
    }

    $host = normalize_host($req->rawHost);
    if (!is_valid_host($host)) {
        [$status, $headers, $body] = not_found();
        send_response($status, $headers, $body, $req->isHead());
        return;
    }

    $path = normalize_path($req->rawPath);
    if (strlen($path) > $cfg['max_path_len']) {
        [$status, $headers, $body] = not_found();
        send_response($status, $headers, $body, $req->isHead());
        return;
    }

    $req->host = $host;
    $req->path = $path;

    $resolved = resolve_routes($host, $path);
    if ($resolved === null) {
        [$status, $headers, $body] = service_unavailable();
        send_response($status, $headers, $body, $req->isHead());
        return;
    }

    [$status, $headers, $body, $outcome, $route] = decide($resolved['routes'], $req, $resolved['gate'] ?? null);
    $www = www_entry_redirect($req, $outcome, $route);
    if ($www !== null) {
        [$status, $headers, $body] = $www;
        $outcome = 'redirect';
        $route = [...$route, 'action' => 'REDIRECT', 'match_type' => 'WWW'];
    }
    // Page served: visit id in the cookie, for the load notice (beacon.php).
    $visitId = null;
    if ($outcome === 'served' && $route !== null && beacon_applies($route, $req)) {
        $visitId = beacon_new_visit_id();
        $headers['Set-Cookie'] = [...(array) ($headers['Set-Cookie'] ?? []), beacon_cookie($visitId)];
    }
    if ($cfg['debug_headers']) {
        $headers['X-Cache'] = $resolved['xcache'];
    }
    send_response($status, $headers, $body, $req->isHead());

    // After the response: nothing here makes the visitor wait. With php-fpm the
    // connection is already closed; without it (dev), it just runs inline.
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }

    $domainId = $resolved['routes'][0]['domain_id'] ?? null;
    $learned = log_hit($req, $status, $outcome, is_string($domainId) ? $domainId : null, $route, $headers['Location'] ?? null, $visitId, $req->rawQuery);

    // A click with a platform click id (fbclid, gclid, ttclid…) goes to dayone-main's tracker (dot.php).
    dot_click($req, $learned + ['domain_id' => $domainId, 'outcome' => $outcome, 'status' => $status, 'route' => $route, 'visit_id' => $visitId]);

    if ($resolved['refresh']) {
        // SWR: refresh the cache with nobody waiting.
        refresh_in_background($host, $path);
    }

    // The local IP → ASN/country table: rebuilt once a day, by one process, with nobody waiting.
    netdb_maybe_refresh();
}
