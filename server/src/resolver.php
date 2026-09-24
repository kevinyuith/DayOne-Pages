<?php
/**
 * O resolvedor: decide de onde vêm as rotas de (host, path).
 *
 *   HIT       cache fresco e com todo conteúdo em disco
 *   MISS      foi ao Supabase e regravou
 *   STALE     Supabase falhou; serviu a cópia expirada
 *   UPDATING  outro worker está atualizando; serviu a cópia expirada
 *   (null)    nada em disco e Supabase fora → quem chama responde 503
 *
 * Com SWR=1 e php-fpm, uma entrada STALE é servida na hora e atualizada
 * DEPOIS de a resposta ir embora (fastcgi_finish_request): o visitante
 * nunca espera pelo Supabase depois da primeira visita.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/**
 * @return array{routes: array, xcache: string, refresh: bool}|null
 */
function resolve_routes(string $host, string $path): ?array
{
    ['state' => $state, 'entry' => $entry] = cache_get_routes($host, $path);

    if ($state === 'FRESH' && cache_has_all_content($entry['routes'])) {
        return ['routes' => $entry['routes'], 'xcache' => 'HIT', 'refresh' => false];
    }

    $cfg = config();
    if ($state === 'STALE' && $cfg['swr'] && function_exists('fastcgi_finish_request')) {
        return ['routes' => $entry['routes'], 'xcache' => 'STALE', 'refresh' => true];
    }

    $lock = try_lock("$host|$path");
    if ($lock !== null) {
        try {
            $fresh = refresh_routes($host, $path);
            if ($fresh !== null) {
                return ['routes' => $fresh, 'xcache' => 'MISS', 'refresh' => false];
            }
            if ($entry !== null) {
                return ['routes' => $entry['routes'], 'xcache' => 'STALE', 'refresh' => false];
            }
            return null;
        } finally {
            unlock($lock);
        }
    }

    // Outro worker está no Supabase.
    if ($entry !== null) {
        return ['routes' => $entry['routes'], 'xcache' => 'UPDATING', 'refresh' => false];
    }
    for ($i = 0; $i < 20; $i++) {
        usleep(100_000);
        ['state' => $s, 'entry' => $e] = cache_get_routes($host, $path);
        if ($s === 'FRESH' && cache_has_all_content($e['routes'])) {
            return ['routes' => $e['routes'], 'xcache' => 'HIT', 'refresh' => false];
        }
    }
    return null;
}

/**
 * Vai ao Supabase e regrava o cache. Devolve as rotas (sem conteúdo) ou
 * null se o Supabase falhou. Quem chama já segura o lock, ou aceita correr.
 */
function refresh_routes(string $host, string $path): ?array
{
    $r = supabase_resolve($host, $path);
    if (!$r['ok']) {
        error_log("[dayone-pages] supabase falhou para $host$path: " . ($r['error'] ?? '?'));
        return null;
    }

    foreach ($r['routes'] as &$row) {
        if (!empty($row['slug_id']) && isset($row['content']) && !empty($row['content_hash'])) {
            cache_put_content((string) $row['slug_id'], (string) $row['content_hash'], (string) $row['content']);
            // Sabendo de antemão que a slug NÃO tem etapas de funil (nem modo
            // servidor, nem amostras A/B), o 304 sai sem ler o conteúdo do disco (ver serve_slug).
            $row['funnel'] = funnel_has_sections((string) $row['content']) || funnel_is_server_mode((string) $row['content']);
        }
        // Teste A/B entre páginas: o conteúdo de cada página do sorteio vai para o cache também.
        if (is_array($row['split'] ?? null)) {
            foreach ($row['split'] as &$c) {
                if (is_array($c) && !empty($c['slug_id']) && isset($c['content']) && !empty($c['content_hash'])) {
                    cache_put_content((string) $c['slug_id'], (string) $c['content_hash'], (string) $c['content']);
                    $c['funnel'] = funnel_has_sections((string) $c['content']) || funnel_is_server_mode((string) $c['content']);
                }
            }
            unset($c);
        }
    }
    unset($row);

    $routes = strip_content($r['routes']);
    if (!host_over_cap($host)) {
        cache_put_routes($host, $path, $routes);
    }
    return $routes;
}

/** A atualização em segundo plano do SWR: com lock, sem pressa. */
function refresh_in_background(string $host, string $path): void
{
    $lock = try_lock("$host|$path");
    if ($lock === null) {
        return;
    }
    try {
        refresh_routes($host, $path);
    } finally {
        unlock($lock);
    }
}
