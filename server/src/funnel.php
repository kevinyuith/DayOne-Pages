<?php
/**
 * Funil em "modo servidor": uma etapa por resposta.
 *
 * O editor grava as sub-páginas de uma slug como <section data-dop-page="…">
 * irmãs no body, e pode marcar o body com data-dop-funnel="server". Nesse
 * modo, este servidor entrega SÓ a etapa atual — as outras seções nem saem no
 * HTML — e o runtime da página troca de etapa gravando o cookie `dop_step` e
 * recarregando a mesma URL. A URL nunca muda; o fonte da presell não contém a
 * página principal.
 *
 * Etapas: sempre Pre Lander (presell) → Lander (main) → Backredirect; tipo
 * desconhecido conta como Lander. Etapa sem código (seção vazia, só espaço ou
 * comentário) está INATIVA: nunca é servida. Mesmas regras do editor
 * (src/lib/pages/subpages.ts) e do runtime.
 *
 * Etapa atual: o cookie, se apontar para uma etapa ativa; senão a inicial —
 * 1) o Pre Lander, se ativo; 2) o Lander. O data-dop-start do HTML não manda.
 *
 * O que o runtime precisa saber sobre as etapas que não vieram vai como
 * atributos no <body>: data-dop-cur, data-dop-next, data-dop-main,
 * data-dop-start, data-dop-br, data-dop-br-trigger.
 *
 * Sem DOMDocument (evita depender de ext/xml): as seções são achadas por um
 * contador de <section>/<\/section>. Antes de contar, comentários, <script>,
 * <style> e <template> são apagados de uma CÓPIA (mesmo tamanho, offsets
 * iguais), para um "</section>" dentro deles não contar. Uma etapa é a
 * primeira <section data-dop-page> aberta fora de outra etapa, em qualquer
 * profundidade (o editor aceita etapas embrulhadas numa <section> comum);
 * ela fecha quando a profundidade volta à de abertura. O conteúdo de cada
 * etapa fica intacto.
 *
 * AMOSTRAS (teste A/B, ver ab_apply): antes de tudo, cada etapa com duas ou
 * mais amostras ativas (seções do mesmo tipo) fica com UMA, sorteada na
 * proporção dos data-dop-weight e fixa por visitante no cookie dop_ab. As
 * outras saem do HTML — em qualquer modo, não só no servidor.
 *
 * Sem modo servidor, devolve null e o HTML vai como está. Modo servidor sem
 * nenhuma etapa encontrada também devolve null, mas registra no log: é sinal
 * de HTML que o tokenizador não entendeu. Sem etapa ativa, null (nada a cortar).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const FUNNEL_COOKIE = 'dop_step';
/** Cookie do teste A/B: "<visitante 16 hex>:<id>,<id>…" — as amostras sorteadas para ele. */
const AB_COOKIE = 'dop_ab';
const AB_MAX_IDS = 24;
const AB_DEFAULT_WEIGHT = 50;
/** No <body>: liga o aviso de visita/clique das amostras no runtime (beacon.php, /_dop/e). */
const FUNNEL_EVENTS_ATTR = 'data-dop-ev';

/** O HTML tem seções de etapa? (barato: uma regex) */
function funnel_has_sections(string $html): bool
{
    return preg_match('/<section\b[^>]*\bdata-dop-page\s*=/i', $html) === 1;
}

/** O body pede modo servidor? (barato: uma regex no HTML) */
function funnel_is_server_mode(string $html): bool
{
    return preg_match('/<body\b[^>]*\bdata-dop-funnel\s*=\s*"server"/i', $html) === 1;
}

/**
 * @return array{html: string, step: string}|null
 */
function funnel_apply(string $html, array $cookies): ?array
{
    if (!funnel_is_server_mode($html)) {
        return null;
    }
    $pages = funnel_sections($html);
    if ($pages === []) {
        error_log('[dayone-pages] funil em modo servidor sem etapa reconhecida; servindo o HTML inteiro');
        return null;
    }

    $first = static function (string $kind) use ($pages): ?array {
        foreach ($pages as $p) {
            if ($p['kind'] === $kind && $p['active']) {
                return $p;
            }
        }
        return null;
    };
    $pre = $first('presell');
    $main = $first('main');
    $br = $first('backredirect');
    $start = $pre ?? $main;
    if ($start === null) {
        return null;
    }
    $byId = [];
    foreach ($pages as $p) {
        if ($p['active']) {
            $byId[$p['id']] = $p;
        }
    }

    $want = (string) ($cookies[FUNNEL_COOKIE] ?? '');
    $cur = (preg_match('/^p_[a-z0-9]{1,16}$/', $want) === 1 && isset($byId[$want])) ? $byId[$want] : $start;

    // "Próxima": do Pre Lander, o Lander; do Lander, nenhuma; da Backredirect
    // (ou de uma seção fora do fluxo), o Lander — ou a inicial.
    if ($pre !== null && $cur['id'] === $pre['id']) {
        $next = $main;
    } elseif ($main !== null && $cur['id'] === $main['id']) {
        $next = null;
    } else {
        $next = $main ?? $start;
    }

    // Remove as outras seções, do fim para o início (os offsets continuam válidos).
    $out = $html;
    foreach (array_reverse($pages) as $p) {
        if ($p['id'] !== $cur['id']) {
            $out = substr($out, 0, $p['from']) . substr($out, $p['to']);
        }
    }

    // A etapa servida não pode vir `hidden` (o atributo é o fallback sem JS do modo navegador).
    $out = funnel_unhide($out, $cur['id']);

    $esc = fn (string $v): string => htmlspecialchars($v, ENT_QUOTES, 'UTF-8');
    $attrs = ' data-dop-cur="' . $esc($cur['id']) . '"'
        . ' data-dop-start="' . $esc($start['id']) . '"'
        . ($next ? ' data-dop-next="' . $esc($next['id']) . '"' : '')
        . ($main ? ' data-dop-main="' . $esc($main['id']) . '"' : '')
        . ($br ? ' data-dop-br="' . $esc($br['id']) . '" data-dop-br-trigger="' . $esc($br['trigger']) . '"' : '');
    // Callback, não string de substituição: um "$1" ou "\" no valor de um atributo não vira backreference.
    $out = preg_replace_callback('/<body\b([^>]*)>/i', fn ($m) => '<body' . $m[1] . $attrs . '>', $out, 1) ?? $out;

    return ['html' => $out, 'step' => $cur['id']];
}

/**
 * As seções de etapa, na ordem do documento, com os offsets no HTML ORIGINAL.
 *
 * @return list<array{id: string, kind: string, start: bool, trigger: string, weight: int, active: bool, from: int, to: int}>
 */
function funnel_sections(string $html): array
{
    $scan = funnel_blank_opaque($html);
    if (preg_match_all('/<(\/?)section\b([^>]*)>/i', $scan, $m, PREG_OFFSET_CAPTURE | PREG_SET_ORDER) === 0) {
        return [];
    }
    $out = [];
    $depth = 0;
    $open = null;      // a etapa aberta
    $openDepth = -1;   // profundidade em que ela abriu
    foreach ($m as $tok) {
        $closing = $tok[1][0] === '/';
        $offset = (int) $tok[0][1];
        $len = strlen($tok[0][0]);
        if (!$closing) {
            if ($open === null && preg_match('/\bdata-dop-page\s*=\s*"([^"]+)"/i', $tok[2][0], $id) === 1) {
                $attrs = $tok[2][0];
                $kind = preg_match('/\bdata-dop-kind\s*=\s*"([^"]*)"/i', $attrs, $k) === 1 ? strtolower($k[1]) : '';
                $open = [
                    'id' => $id[1],
                    'kind' => in_array($kind, ['presell', 'backredirect'], true) ? $kind : 'main',
                    'start' => preg_match('/\bdata-dop-start\b/i', $attrs) === 1,
                    'trigger' => preg_match('/\bdata-dop-trigger\s*=\s*"([^"]*)"/i', $attrs, $t) === 1 ? $t[1] : '',
                    'weight' => preg_match('/\bdata-dop-weight\s*=\s*"(\d{1,3})"/i', $attrs, $w) === 1 ? min(100, (int) $w[1]) : AB_DEFAULT_WEIGHT,
                    'active' => false,
                    'from' => $offset,
                    'to' => $offset + $len,
                ];
                $openDepth = $depth;
            }
            $depth++;
            continue;
        }
        $depth = max(0, $depth - 1);
        if ($open !== null && $depth === $openDepth) {
            $open['active'] = funnel_has_code(substr($html, $open['to'], $offset - $open['to']));
            $open['to'] = $offset + $len;
            $out[] = $open;
            $open = null;
            $openDepth = -1;
        }
    }
    return $out;
}

/** Tira o `hidden` da seção `id`. Cobre hidden, hidden="", hidden='', hidden=hidden, hidden="hidden". */
function funnel_unhide(string $html, string $id): string
{
    return preg_replace_callback(
        '/<section\b[^>]*\bdata-dop-page\s*=\s*"' . preg_quote($id, '/') . '"[^>]*>/i',
        fn ($m) => preg_replace('/\s+hidden(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>\/]+))?(?=[\s>\/])/i', '', $m[0]) ?? $m[0],
        $html,
        1,
    ) ?? $html;
}

/**
 * Teste A/B: em cada etapa com duas ou mais amostras ATIVAS, fica uma — a que
 * o cookie dop_ab já tem para este visitante, senão uma sorteada na proporção
 * dos pesos (todos 0 = partes iguais). As outras saem do HTML. Também liga o
 * aviso de visita/clique (data-dop-ev no <body>) em toda página com etapas.
 *
 * `tag` entra no ETag (cada combinação é um corpo diferente na mesma URL);
 * `cookie` é o valor novo do dop_ab, ou null se não mudou. `$rand(max)`
 * devolve um inteiro em [0, max) — os testes passam um fixo.
 *
 * @return array{html: string, tag: string, cookie: ?string}|null  null = sem etapas
 */
function ab_apply(string $html, array $cookies, ?callable $rand = null): ?array
{
    if (!funnel_has_sections($html)) {
        return null;
    }
    $pages = funnel_sections($html);
    if ($pages === []) {
        return null;
    }
    $raw = (string) ($cookies[AB_COOKIE] ?? '');
    [$uid, $known] = ab_parse_cookie($raw);

    $byKind = [];
    foreach ($pages as $p) {
        if ($p['active']) {
            $byKind[$p['kind']][] = $p;
        }
    }
    $chosen = [];
    $inTests = [];
    $drop = [];
    foreach (['presell', 'main', 'backredirect'] as $kind) {
        $versions = $byKind[$kind] ?? [];
        if (count($versions) < 2) {
            continue;
        }
        // Peso 0 = amostra pausada: nem quem já tinha caído nela continua.
        $total = array_sum(array_column($versions, 'weight'));
        $pick = null;
        foreach ($versions as $v) {
            $inTests[$v['id']] = true;
            if ($pick === null && in_array($v['id'], $known, true) && ($v['weight'] > 0 || $total === 0)) {
                $pick = $v;
            }
        }
        $pick ??= ab_pick($versions, $rand);
        $chosen[] = $pick['id'];
        foreach ($versions as $v) {
            if ($v['id'] !== $pick['id']) {
                $drop[$v['id']] = true;
            }
        }
    }

    $out = $html;
    foreach (array_reverse($pages) as $p) {
        if (isset($drop[$p['id']])) {
            $out = substr($out, 0, $p['from']) . substr($out, $p['to']);
        }
    }
    // A amostra sorteada da etapa inicial fica visível sem JS (o editor marcou a primeira).
    $startKind = isset($byKind['presell']) ? 'presell' : 'main';
    foreach ($chosen as $id) {
        foreach ($byKind[$startKind] ?? [] as $v) {
            if ($v['id'] === $id) {
                $out = funnel_unhide($out, $id);
            }
        }
    }
    $out = preg_replace_callback('/<body\b([^>]*)>/i', fn ($m) => '<body' . $m[1] . ' ' . FUNNEL_EVENTS_ATTR . '>', $out, 1) ?? $out;

    // Cookie: o visitante (novo, se não tinha) + as sorteadas daqui + as de outras páginas.
    $uid ??= bin2hex(random_bytes(8));
    $ids = $chosen;
    foreach ($known as $id) {
        if (!isset($inTests[$id]) && !in_array($id, $ids, true)) {
            $ids[] = $id;
        }
    }
    $value = $uid . ($ids !== [] ? ':' . implode(',', array_slice($ids, 0, AB_MAX_IDS)) : '');

    return ['html' => $out, 'tag' => implode('.', $chosen), 'cookie' => $value === $raw ? null : $value];
}

/**
 * "<16 hex>:<id>,<id>" → [visitante, ids]. Valor malformado → [null, []].
 *
 * @return array{0: ?string, 1: list<string>}
 */
function ab_parse_cookie(string $raw): array
{
    if (preg_match('/^([0-9a-f]{16})(?::((?:p_[a-z0-9]{1,16})(?:,p_[a-z0-9]{1,16})*))?$/', $raw, $m) !== 1) {
        return [null, []];
    }
    return [$m[1], isset($m[2]) && $m[2] !== '' ? explode(',', $m[2]) : []];
}

/** Sorteia uma amostra na proporção dos pesos (todos 0 = partes iguais). */
function ab_pick(array $versions, ?callable $rand): array
{
    $rand ??= fn (int $max): int => random_int(0, $max - 1);
    $total = array_sum(array_column($versions, 'weight'));
    if ($total <= 0) {
        return $versions[$rand(count($versions))];
    }
    $r = $rand($total);
    foreach ($versions as $v) {
        $r -= $v['weight'];
        if ($r < 0) {
            return $v;
        }
    }
    return $versions[count($versions) - 1];
}

function ab_cookie(string $value): string
{
    return AB_COOKIE . "=$value; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax";
}

// ── Teste A/B entre as páginas de um funil ─────────────────────────────────

/** Cookie do sorteio entre páginas: os ids (uuid) das páginas de domínio já sorteadas para o visitante. */
const SPLIT_COOKIE = 'dop_pg';
const SPLIT_MAX_IDS = 10;

/**
 * A rota resolveu para uma página que é cópia de uma página de funil, e o
 * domínio tem outras cópias do mesmo funil no mesmo path (`split`, vindo do
 * pages.resolve): fica a que o cookie dop_pg já tem para este visitante (se
 * não estiver pausada), senão uma sorteada pelos pesos (todos 0 = partes
 * iguais). Devolve a rota com a página escolhida no lugar e o valor novo do
 * cookie (null = não mudou). Sem split, a rota volta como está.
 *
 * @return array{0: array, 1: ?string}
 */
function split_pick(array $route, array $cookies, ?callable $rand = null): array
{
    $split = $route['split'] ?? null;
    if (!is_array($split) || count($split) < 2) {
        return [$route, null];
    }
    $raw = (string) ($cookies[SPLIT_COOKIE] ?? '');
    $known = preg_match('/^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/', $raw) === 1 ? explode(',', $raw) : [];
    $candidates = array_values(array_filter($split, fn ($c) => is_array($c) && is_string($c['page_id'] ?? null) && !empty($c['slug_id'])));
    if (count($candidates) < 2) {
        return [$route, null];
    }
    foreach ($candidates as &$c) {
        $c['weight'] = max(0, min(100, (int) ($c['weight'] ?? 0)));
    }
    unset($c);
    $total = array_sum(array_column($candidates, 'weight'));

    $pick = null;
    foreach ($candidates as $c) {
        if (in_array($c['page_id'], $known, true) && ($c['weight'] > 0 || $total === 0)) {
            $pick = $c;
            break;
        }
    }
    $pick ??= ab_pick($candidates, $rand);

    $ids = array_column($candidates, 'page_id');
    $keep = array_values(array_filter($known, fn ($id) => !in_array($id, $ids, true)));
    $value = implode(',', array_slice([$pick['page_id'], ...$keep], 0, SPLIT_MAX_IDS));

    $chosen = [...$route];
    foreach (['page_id', 'slug_id', 'content_type', 'content_hash', 'funnel'] as $k) {
        if (array_key_exists($k, $pick)) {
            $chosen[$k] = $pick[$k];
        }
    }
    unset($chosen['split']);
    $chosen['split_count'] = count($candidates);
    return [$chosen, $value === $raw ? null : $value];
}

function split_cookie(string $value): string
{
    return SPLIT_COOKIE . "=$value; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax";
}

/**
 * O miolo de uma etapa tem código? Comentário, espaço e &nbsp; não contam (no
 * editor e no runtime, um nó de texto só com espaço/NBSP também não).
 */
function funnel_has_code(string $inner): bool
{
    return trim((string) preg_replace('/<!--.*?-->|&nbsp;|&#160;|&#xa0;|\xC2\xA0/is', '', $inner)) !== '';
}

/**
 * Cópia do HTML com comentários, <script>, <style> e <template> trocados por
 * espaços — mesmo comprimento, então todo offset achado nela vale no original.
 * Um "</section>" dentro de um comentário ou de uma string JS deixa de contar.
 */
function funnel_blank_opaque(string $html): string
{
    return preg_replace_callback(
        '/<!--.*?-->|<(script|style|template)\b[^>]*>.*?<\/\1\s*>/is',
        fn ($m) => str_repeat(' ', strlen($m[0])),
        $html,
    ) ?? $html;
}
