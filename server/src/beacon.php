<?php
/**
 * Aviso de carregamento: separa "a página carregou no navegador" de ping,
 * curl, prefetch e robô de prévia de link, que também viram "served".
 *
 *   1. Página HTML servida (200/304) ganha um id de visita no cookie dop_v
 *      (HttpOnly, 10 min) e, antes do </body>, um script mínimo.
 *   2. No evento load, o script faz sendBeacon("/_dop/l", "t=<ms>"), com o
 *      tempo desde o início da navegação. No primeiro clique que sai da
 *      página (link ou data-href que navega; "#…" não conta), manda "c=1".
 *   3. /_dop/l responde 204 na hora e, depois da resposta, grava o id em
 *      pages.hit_loads (RPC log_load; o clique, log_click). A tela de Logs
 *      junta com hits.visit_id, e a tela Funil soma carregamentos e cliques
 *      por página (teste A/B entre as páginas de um funil).
 *
 * O id vai no cookie, não no HTML, para o script ser sempre o mesmo: o corpo
 * continua cacheável e um 304 (que não tem corpo) ainda leva o id novo no
 * Set-Cookie. O ETag ganha BEACON_ETAG para cópias antigas, sem o script,
 * não serem reaproveitadas pelo navegador.
 *
 * Só mede. Não muda o que o visitante vê.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const BEACON_PATH = '/_dop/l';
const BEACON_COOKIE = 'dop_v';
/** Sufixo do ETag das páginas com o script. Mudou o script, muda a versão. */
const BEACON_ETAG = '-b2';
const BEACON_SCRIPT = '<script data-dop-beacon>(function(){function b(d){try{navigator.sendBeacon("' . BEACON_PATH . '",d)}catch(e){}}'
    . 'function s(){b("t="+Math.round(performance.now()))}if(document.readyState==="complete")s();else addEventListener("load",s,{once:true});'
    . 'var c=false;addEventListener("click",function(e){if(c)return;var t=e.target,a=t&&t.closest&&t.closest("a[href],[data-href]");if(!a)return;'
    . 'var h=a.getAttribute("data-href")||a.getAttribute("href")||"";if(!h||h.charAt(0)==="#"||h.indexOf("javascript:")===0)return;c=true;b("c=1")},true)})();</script>';

/** A resposta desta rota leva o aviso? Só página HTML (.html, .php ou sem extensão). */
function beacon_applies(array $route, Request $req): bool
{
    $type = (string) ($route['content_type'] ?? '') ?: 'text/html';
    return str_starts_with(strtolower($type), 'text/html') && is_logged_path($req->path);
}

/** O script antes do último </body>; sem </body>, no fim. */
function beacon_inject(string $html): string
{
    $pos = strripos($html, '</body>');
    return $pos === false ? $html . BEACON_SCRIPT : substr_replace($html, BEACON_SCRIPT, $pos, 0);
}

function beacon_new_visit_id(): string
{
    return bin2hex(random_bytes(16));
}

function beacon_cookie(string $visitId): string
{
    return BEACON_COOKIE . "=$visitId; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax";
}

/**
 * POST /_dop/l → 204 + [id da visita, ms, clicou?] para gravar depois da
 * resposta ("c=1" = o visitante clicou para fora da página). Sem cookie
 * válido, 204 e nada a gravar. Outro método: 404.
 *
 * @return array{0: int, 1: array<string,string>, 2: ?string, 3: ?string, 4: ?int, 5: bool}
 */
function handle_beacon(Request $req, string $body): array
{
    if ($req->method !== 'POST') {
        return [...not_found(), null, null, false];
    }
    $visitId = (string) ($req->cookies[BEACON_COOKIE] ?? '');
    if (preg_match('/^[0-9a-f]{32}$/', $visitId) !== 1) {
        $visitId = null;
    }
    parse_str($body, $form);
    $t = $form['t'] ?? null;
    $ms = is_string($t) && ctype_digit($t) && (int) $t <= 600000 ? (int) $t : null;
    return [204, ['Cache-Control' => 'no-store'], null, $visitId, $ms, ($form['c'] ?? null) === '1'];
}

// ── Aviso de visita/clique das amostras do funil (teste A/B) ────────────────

const FUNNEL_EVENT_PATH = '/_dop/e';

/**
 * POST /_dop/e ("e=v|c&p=<id da amostra>&k=<etapa>&s=<path>") → 204 na hora +
 * o evento para gravar depois da resposta (pages.log_funnel_event). O runtime
 * só manda com data-dop-ev no <body>, que o servidor põe (ab_apply). Sem o
 * cookie dop_ab válido, de robô ou malformado: 204 e nada a gravar. Outro
 * método: 404.
 *
 * @return array{0: int, 1: array<string,string>, 2: ?string, 3: ?array{host: string, path: string, step: string, kind: string, event: string, visitor: string}}
 */
function handle_funnel_event(Request $req, string $body): array
{
    if ($req->method !== 'POST') {
        return [...not_found(), null];
    }
    $ok = [204, ['Cache-Control' => 'no-store'], null];
    [$visitor] = ab_parse_cookie((string) ($req->cookies[AB_COOKIE] ?? ''));
    if ($visitor === null || is_bot_ua($req->userAgent)) {
        return [...$ok, null];
    }
    parse_str($body, $form);
    $event = ['v' => 'view', 'c' => 'click'][(string) ($form['e'] ?? '')] ?? null;
    $step = (string) ($form['p'] ?? '');
    $kind = (string) ($form['k'] ?? '');
    $path = normalize_path((string) ($form['s'] ?? ''));
    $host = normalize_host($req->rawHost);
    if (
        $event === null
        || preg_match('/^p_[a-z0-9]{1,16}$/', $step) !== 1
        || !in_array($kind, ['presell', 'main', 'backredirect'], true)
        || !str_starts_with($path, '/') || strlen($path) > 512
        || !is_valid_host($host)
    ) {
        return [...$ok, null];
    }
    return [...$ok, ['host' => $host, 'path' => $path, 'step' => $step, 'kind' => $kind, 'event' => $event, 'visitor' => $visitor]];
}
