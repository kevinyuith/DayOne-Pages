<?php
/**
 * De rotas candidatas a uma resposta.
 *
 * As rotas chegam em ordem de prioridade, com a FALLBACK (página padrão do
 * domínio) por último. A primeira cujas `conditions` casam decide:
 *
 *   SERVE     slug_id nulo → 404 (a rota existe mas a slug não; não pula
 *             para a próxima, para o erro aparecer em vez de sumir).
 *             If-None-Match igual ao hash → 304. Senão 200 com o HTML.
 *             Slug com funil em modo servidor (funnel.php): só a etapa atual
 *             sai, o ETag ganha o id da etapa e a resposta varia por Cookie.
 *   REDIRECT  Location = redirect_url (+ query original se preserve_query).
 *   BLOCK     o status configurado, com uma página mínima.
 *
 * Rota com condição `bot` fora de BLOCK é ignorada: detecção de bot serve
 * para barrar, nunca para trocar o conteúdo.
 *
 * Nenhuma casou: robots.txt tem uma resposta padrão; o resto é 404.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const PRIVATE_NO_CACHE = 'private, no-cache';

/**
 * Devolve [status, headers, body, outcome, rota]. `outcome` classifica o hit
 * para o registro de tráfego: served | redirect | blocked | bot | notfound |
 * error. `rota` é a que decidiu (null se nenhuma casou), também para o registro.
 *
 * @return array{0: int, 1: array<string,string>, 2: ?string, 3: string, 4: ?array}
 */
function decide(array $routes, Request $req): array
{
    foreach ($routes as $route) {
        $cond = is_array($route['conditions'] ?? null) ? $route['conditions'] : [];
        $action = (string) ($route['action'] ?? '');

        if (array_key_exists('bot', $cond) && $action !== 'BLOCK') {
            error_log('[dayone-pages] rota com condição bot fora de BLOCK ignorada: ' . ($route['route_id'] ?? '?'));
            continue;
        }
        if (!conditions_match($cond, $req)) {
            continue;
        }

        switch ($action) {
            case 'SERVE':
                $r = serve_slug($route, $req);
                return [$r[0], $r[1], $r[2], serve_outcome($r[0]), $route];
            case 'REDIRECT':
                $r = redirect_to($route, $req);
                return [$r[0], $r[1], $r[2], 'redirect', $route];
            case 'BLOCK':
                $r = block($route);
                $bot = ($route['match_type'] ?? '') === 'BOTGATE' || array_key_exists('bot', $cond);
                return [$r[0], $r[1], $r[2], $bot ? 'bot' : 'blocked', $route];
            default:
                continue 2;
        }
    }

    if ($req->path === '/robots.txt') {
        return [...robots_default(), 'served', null];
    }
    return [...not_found(), 'notfound', null];
}

/** Traduz o status de uma rota SERVE em outcome de tráfego. */
function serve_outcome(int $status): string
{
    return match ($status) {
        404 => 'notfound',
        503 => 'error',
        default => 'served', // 200 e 304
    };
}

function robots_default(): array
{
    return [200, ['Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'public, max-age=3600'], "User-agent: *\nAllow: /\n"];
}

function serve_slug(array $route, Request $req): array
{
    $slugId = (string) ($route['slug_id'] ?? '');
    $hash = (string) ($route['content_hash'] ?? '');
    if ($slugId === '' || $hash === '') {
        // A rota casou mas a slug não existe. robots.txt ganha o padrão; o resto é 404.
        return $req->path === '/robots.txt' ? robots_default() : not_found();
    }

    $headers = [
        'Content-Type' => (string) ($route['content_type'] ?: 'text/html; charset=utf-8'),
        'Cache-Control' => PRIVATE_NO_CACHE,
        'Vary' => 'CF-IPCountry, User-Agent, Accept-Language',
    ];

    // Slug que o cache já marcou como "não é funil em modo servidor": o ETag é
    // só o hash e o 304 sai sem ler o conteúdo do disco. Cache antigo (sem a
    // marca) ou funil: lê o conteúdo, porque a etapa entra no ETag.
    if (($route['funnel'] ?? null) === false) {
        $headers['ETag'] = '"' . $hash . '"';
        if ($req->ifNoneMatch !== null && etag_matches($req->ifNoneMatch, $headers['ETag'])) {
            return [304, $headers, null];
        }
    }

    $body = cache_read_content($slugId, $hash);
    if ($body === null) {
        error_log("[dayone-pages] conteúdo ausente no cache para slug $slugId ($hash)");
        return [503, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store', 'Retry-After' => '10'], plain_page('Um instante', 'Atualizando a página. Tente de novo em alguns segundos.')];
    }

    // Funil em modo servidor: a etapa entra no ETag (cada etapa é um corpo
    // diferente na MESMA URL) e a resposta passa a variar por Cookie.
    $funnel = funnel_apply($body, $req->cookies);
    $etag = '"' . $hash . ($funnel ? '-' . $funnel['step'] : '') . '"';
    if ($funnel) {
        $body = $funnel['html'];
        $headers['Vary'] .= ', Cookie';
    }
    $headers['ETag'] = $etag;

    if ($req->ifNoneMatch !== null && etag_matches($req->ifNoneMatch, $etag)) {
        return [304, $headers, null];
    }

    return [200, $headers, $body];
}

function etag_matches(string $header, string $etag): bool
{
    foreach (explode(',', $header) as $candidate) {
        $c = trim($candidate);
        if ($c === '*' || $c === $etag || $c === 'W/' . $etag) {
            return true;
        }
    }
    return false;
}

function redirect_to(array $route, Request $req): array
{
    $location = (string) ($route['redirect_url'] ?? '');
    if (!empty($route['preserve_query']) && $req->rawQuery !== '') {
        $location .= (str_contains($location, '?') ? '&' : '?') . $req->rawQuery;
    }
    $status = (int) ($route['status_code'] ?? 302);
    if (!in_array($status, [301, 302, 307, 308], true)) {
        $status = 302;
    }
    return [$status, ['Location' => $location, 'Cache-Control' => PRIVATE_NO_CACHE], ''];
}

function block(array $route): array
{
    $status = (int) ($route['status_code'] ?? 404);
    if (!in_array($status, [403, 404, 410, 451], true)) {
        $status = 404;
    }
    $title = match ($status) {
        403 => 'Acesso negado',
        410 => 'Página removida',
        451 => 'Indisponível',
        default => 'Página não encontrada',
    };
    return [$status, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => PRIVATE_NO_CACHE], plain_page($title, '')];
}

function not_found(): array
{
    return [404, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => PRIVATE_NO_CACHE], plain_page('Página não encontrada', 'O endereço não existe neste domínio.')];
}

function service_unavailable(): array
{
    return [503, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store', 'Retry-After' => '30'], plain_page('Um instante', 'O site está sendo carregado. Tente de novo em alguns segundos.')];
}
