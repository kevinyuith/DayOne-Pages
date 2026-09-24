<?php
/**
 * A única chamada ao Supabase: POST /rest/v1/rpc/resolve.
 *
 * Vai com a chave publicável (anon) e com a chave DESTE servidor
 * (PAGES_SERVER_KEY), cujo hash vive em pages.server_keys. A função no banco
 * é SECURITY DEFINER e devolve rotas + HTML numa ida só. A chave de serviço
 * nunca chega a esta máquina.
 *
 * `Content-Profile: pages` porque a função não mora no schema `public`.
 * Chave inválida → 403 do PostgREST → tratamos como erro (nunca como 404
 * negativo, senão uma chave rotacionada apagaria todos os sites até o cache negativo vencer).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/**
 * @return array{ok: bool, routes?: array, error?: string, status?: int}
 */
function supabase_resolve(string $host, string $path): array
{
    $cfg = config();
    if ($cfg['supabase_url'] === '' || $cfg['supabase_anon_key'] === '' || $cfg['server_key'] === '') {
        return ['ok' => false, 'error' => 'SUPABASE_URL, SUPABASE_ANON_KEY ou PAGES_SERVER_KEY ausente'];
    }

    $body = json_encode(['p_host' => $host, 'p_path' => $path, 'p_key' => $cfg['server_key']]);
    if ($body === false) {
        return ['ok' => false, 'error' => 'json_encode'];
    }

    $ch = curl_init($cfg['supabase_url'] . '/rest/v1/rpc/resolve');
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
    // Sem curl_close(): é no-op desde o PHP 8.0 e deprecado no 8.5.

    if ($raw === false) {
        return ['ok' => false, 'error' => 'curl: ' . $err];
    }
    if ($status !== 200) {
        // Nunca loga o corpo com a chave; o status basta para diagnosticar.
        return ['ok' => false, 'error' => "HTTP $status", 'status' => $status];
    }

    $rows = json_decode((string) $raw, true);
    if (!is_array($rows)) {
        return ['ok' => false, 'error' => 'resposta não é JSON'];
    }

    return ['ok' => true, 'routes' => array_values($rows)];
}

/**
 * Grava um hit: POST /rest/v1/rpc/log_hit. Mesma porta do resolve (anon +
 * server key). Fire-and-forget — nunca derruba a resposta ao visitante; falha
 * vai só para o log. Deve ser chamada DEPOIS de fastcgi_finish_request.
 *
 * @param array<string,mixed> $params já com as chaves p_* (menos p_key)
 */
function supabase_log_hit(array $params): void
{
    supabase_fire('log_hit', $params);
}

/** Grava o aviso de carregamento de uma visita (beacon.php). Mesmas regras de supabase_log_hit. */
function supabase_log_load(string $visitId, ?int $loadMs): void
{
    supabase_fire('log_load', ['p_visit_id' => $visitId, 'p_load_ms' => $loadMs]);
}

function supabase_log_click(string $visitId): void
{
    supabase_fire('log_click', ['p_visit_id' => $visitId]);
}

/** @param array{host: string, path: string, step: string, kind: string, event: string, visitor: string} $e */
function supabase_log_funnel_event(array $e): void
{
    supabase_fire('log_funnel_event', [
        'p_host' => $e['host'], 'p_path' => $e['path'], 'p_step' => $e['step'],
        'p_kind' => $e['kind'], 'p_event' => $e['event'], 'p_visitor' => $e['visitor'],
    ]);
}

/** POST numa RPC de registro (pages.<fn>) com p_key; resposta ignorada, falha só no log. */
function supabase_fire(string $fn, array $params): void
{
    $cfg = config();
    if ($cfg['supabase_url'] === '' || $cfg['supabase_anon_key'] === '' || $cfg['server_key'] === '') {
        return;
    }

    $body = json_encode(['p_key' => $cfg['server_key']] + $params);
    if ($body === false) {
        return;
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
            'Prefer: return=minimal',
        ],
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    if ($raw === false || ($status !== 200 && $status !== 204)) {
        error_log("[dayone-pages] $fn falhou (HTTP $status)");
    }
}
