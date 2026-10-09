<?php
/**
 * The flow of a request, end to end.
 *
 *   /_health, /_purge      → internal handlers
 *   /_dop/l                → browser load notice (beacon.php)
 *   /_dop/dot.js           → the funnel's tracker (track.php)
 *   /_dop/a/<bucket>/<f>   → a page's file (image, font, CSS, JS, video) from disk (assets.php)
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
    // The funnel's trackers, first party on every domain (track.php): no hit, no Supabase.
    $tracker = handle_tracker($req);
    if ($tracker !== null) {
        [$status, $headers, $body] = $tracker;
        send_response($status, $headers, $body, $req->isHead());
        return;
    }
    // The pages' files, first party on every domain (assets.php): no hit; Supabase only for a file not on disk yet.
    if (str_starts_with($req->rawPath, ASSETS_PATH)) {
        assets_send($req, isset($_SERVER['HTTP_RANGE']) ? (string) $_SERVER['HTTP_RANGE'] : null);
        return;
    }
    if ($req->rawPath === BEACON_PATH) {
        // The signals JSON (sg) rides along: the body is still tiny (≲2 KB).
        [$status, $headers, $body, $visitId, $notice] = handle_beacon($req, (string) file_get_contents('php://input', false, null, 0, 4096));
        send_response($status, $headers, $body, false);
        if ($visitId !== null) {
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            // On the hit (pages.hits); retried while the hit isn't written yet.
            $recorded = beacon_record(static fn () => beacon_send($visitId, $notice));
            // Still no hit (it may be in the spool itself), or Supabase down: the
            // notice waits in the spool, with this request's time (logspool.php).
            if ($recorded === false || ($recorded === null && log_spool_retryable(supabase_last_status()))) {
                $at = (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
                foreach (log_spool_notice_items($visitId, $notice) as $item) {
                    log_spool($item, $at);
                }
            }
        }
        return;
    }
    if ($req->rawPath === '/_purge') {
        [$status, $headers, $body] = handle_purge($req);
        send_response($status, $headers, $body, false);
        return;
    }

    // The device checkpoint's form POST (eval.php): the browser posted the
    // device's signals back to the same URL. The payload goes on the request
    // and the flow continues as a GET would: the gate re-decides with the
    // signals now known and the final page (safe or funnel) is the response.
    $evalBody = null;
    if ($req->method === 'POST') {
        $evalBody = (string) file_get_contents('php://input', false, null, 0, 8192);
        if (eval_post_payload($req, $evalBody) === null) {
            send_response(405, ['Allow' => 'GET, HEAD', 'Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store'], "Method not allowed\n", false);
            return;
        }
    } elseif ($req->method !== 'GET' && $req->method !== 'HEAD') {
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

    // The checkpoint POST's payload, now that the request is normalized.
    if ($evalBody !== null) {
        $payload = eval_post_payload($req, $evalBody);
        if ($payload !== null) {
            [$evalReq, $evalSignals, $deviceFingerprint] = $payload;
            $req = $evalReq;
            $req->host = $host;
            $req->path = $path;
            $req->evalSignals = $evalSignals;
            $req->deviceFingerprint = $deviceFingerprint;
        }
    }

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
    // A funnel's step switch: the runtime set dop_step and reloaded. The cookie
    // goes (it only carries the switch — a refresh starts over at the first
    // step) and a served page's hit is marked as the same visit's step. The
    // checkpoint page keeps it: its POST comes back to this URL and must serve
    // the step the visitor asked for, not the first one again.
    if (funnel_step_cookie($req->cookies) !== null && !eval_route_is_checkpoint($route)) {
        $clear = funnel_step_cookie_clear($req->rawPath);
        if ($clear !== null) {
            $headers['Set-Cookie'] = [...(array) ($headers['Set-Cookie'] ?? []), $clear];
        }
        if ($outcome === 'served' && $route !== null) {
            $route['_step'] = true;
        }
    }
    // Page served: visit id in the cookie, for the load notice (beacon.php).
    $visitId = null;
    if ($outcome === 'served' && $route !== null && beacon_applies($route, $req)) {
        $visitId = beacon_new_visit_id();
        $headers['Set-Cookie'] = [...(array) ($headers['Set-Cookie'] ?? []), beacon_cookie($visitId)];
        // The funnel page the visitor got (the split's pick), for the page's tracker: see beacon.php.
        $pageCookie = page_id_cookie((string) ($route['page_id'] ?? ''));
        if ($pageCookie !== null) {
            $headers['Set-Cookie'][] = $pageCookie;
        }
    }
    // The device checkpoint: the interstitial page marks the visitor as
    // "checking"; a POST that passed gets the ok cookie, a POST a rule caught
    // gets neither.
    $evalCookie = eval_response_cookie($route);
    if ($evalCookie !== null) {
        $headers['Set-Cookie'] = [...(array) ($headers['Set-Cookie'] ?? []), $evalCookie];
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
    $learned = log_hit($req, $status, $outcome, is_string($domainId) ? $domainId : null, $route, $headers['Location'] ?? null, $visitId, $req->rawQuery, is_array($resolved['gate'] ?? null) ? $resolved['gate'] : null);

    // A click with a platform click id (fbclid, gclid, ttclid…) goes to dayone-main's tracker (dot.php).
    dot_click($req, $learned + ['domain_id' => $domainId, 'outcome' => $outcome, 'status' => $status, 'route' => $route, 'visit_id' => $visitId]);
    // Clicks dot didn't take earlier go again (at most once a minute, one process).
    if (config()['dot_clicks']) {
        dot_spool_replay();
    }
    // Hits and notices Supabase didn't take go again, in batches (logspool.php).
    if (config()['log_hits']) {
        log_spool_replay();
    }

    if ($resolved['refresh']) {
        // SWR: refresh the cache with nobody waiting.
        refresh_in_background($host, $path);
    }
    // The pages served or refreshed without their delivery version: their files come down and it's written (assets.php).
    assets_prepare_pending();

    // The local IP → ASN/country table: rebuilt once a day, by one process, with nobody waiting.
    netdb_maybe_refresh();
    // The local table of who each IP block was delegated to (the hit's ip_block): the same.
    rirdb_maybe_refresh();
    // The known anonymizers (the hit's is_vpn / vpn_kind / vpn_name): the same.
    anondb_maybe_refresh();
}
