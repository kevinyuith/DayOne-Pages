<?php
/**
 * Endpoints internos: /_health e /_purge.
 *
 * /_health não depende do Supabase — é liveness. Devolve o marcador
 * X-DayOne-Pages (SERVER_ID), que é como o dashboard confirma que um domínio
 * chegou neste servidor.
 *
 * /_purge apaga as entradas de rotas de um host (ou tudo). Só POST, com
 * X-Purge-Token comparado em tempo constante. Sem token configurado ou com
 * token errado responde 404, não 401: não confirma que a rota existe.
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
