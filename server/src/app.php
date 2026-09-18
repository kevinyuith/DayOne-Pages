<?php
/**
 * O fluxo de uma request, de ponta a ponta.
 *
 *   /_health, /_purge      → handlers internos
 *   método ∉ {GET, HEAD}   → 405
 *   host inválido          → 404 (sem cache, sem Supabase)
 *   path longo demais      → 404 (idem)
 *   resolver               → HIT | MISS | STALE | UPDATING | null (503)
 *   decide                 → SERVE | REDIRECT | BLOCK | 404
 *
 * X-Cache só sai com DEBUG_HEADERS=1. Em HEAD o corpo não vai.
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

    [$status, $headers, $body] = decide($resolved['routes'], $req);
    if ($cfg['debug_headers']) {
        $headers['X-Cache'] = $resolved['xcache'];
    }
    send_response($status, $headers, $body, $req->isHead());

    if ($resolved['refresh']) {
        // SWR: a resposta já foi; agora atualiza sem ninguém esperando.
        fastcgi_finish_request();
        refresh_in_background($host, $path);
    }
}
