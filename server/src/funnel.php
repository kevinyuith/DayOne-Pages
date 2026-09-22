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
 * Etapa atual: o cookie, se apontar para uma etapa que existe; senão a
 * inicial (data-dop-start), senão a primeira que não é back redirect.
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
 * Sem modo servidor, devolve null e o HTML vai como está. Modo servidor com
 * menos de duas etapas encontradas também devolve null, mas registra no log:
 * é sinal de HTML que o tokenizador não entendeu.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const FUNNEL_COOKIE = 'dop_step';

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
    if (count($pages) < 2) {
        error_log('[dayone-pages] funil em modo servidor com ' . count($pages) . ' etapa(s) reconhecida(s); servindo o HTML inteiro');
        return null;
    }

    $flow = array_values(array_filter($pages, fn ($p) => $p['kind'] !== 'backredirect'));
    $byId = [];
    foreach ($pages as $p) {
        $byId[$p['id']] = $p;
    }
    $start = null;
    foreach ($pages as $p) {
        if ($p['start']) {
            $start = $p;
            break;
        }
    }
    $start ??= $flow[0] ?? $pages[0];
    $main = null;
    foreach ($flow as $p) {
        if ($p['kind'] === 'main') {
            $main = $p;
            break;
        }
    }
    $br = null;
    foreach ($pages as $p) {
        if ($p['kind'] === 'backredirect') {
            $br = $p;
            break;
        }
    }

    $want = (string) ($cookies[FUNNEL_COOKIE] ?? '');
    $cur = (preg_match('/^p_[a-z0-9]{1,16}$/', $want) === 1 && isset($byId[$want])) ? $byId[$want] : $start;

    // "Próxima": a seguinte no fluxo; fora do fluxo (back redirect), a principal ou a inicial.
    $next = null;
    $idx = null;
    foreach ($flow as $i => $p) {
        if ($p['id'] === $cur['id']) {
            $idx = $i;
            break;
        }
    }
    if ($idx === null) {
        $next = $main ?? $start;
    } elseif (isset($flow[$idx + 1])) {
        $next = $flow[$idx + 1];
    }

    // Remove as outras seções, do fim para o início (os offsets continuam válidos).
    $out = $html;
    foreach (array_reverse($pages) as $p) {
        if ($p['id'] !== $cur['id']) {
            $out = substr($out, 0, $p['from']) . substr($out, $p['to']);
        }
    }

    // A etapa servida não pode vir `hidden` (o atributo é o fallback sem JS do
    // modo navegador). Cobre hidden, hidden="", hidden='', hidden=hidden, hidden="hidden".
    $out = preg_replace_callback(
        '/<section\b[^>]*\bdata-dop-page\s*=\s*"' . preg_quote($cur['id'], '/') . '"[^>]*>/i',
        fn ($m) => preg_replace('/\s+hidden(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>\/]+))?(?=[\s>\/])/i', '', $m[0]) ?? $m[0],
        $out,
        1,
    ) ?? $out;

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
 * @return list<array{id: string, kind: string, start: bool, trigger: string, from: int, to: int}>
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
                $open = [
                    'id' => $id[1],
                    'kind' => preg_match('/\bdata-dop-kind\s*=\s*"([^"]*)"/i', $attrs, $k) === 1 ? strtolower($k[1]) : 'main',
                    'start' => preg_match('/\bdata-dop-start\b/i', $attrs) === 1,
                    'trigger' => preg_match('/\bdata-dop-trigger\s*=\s*"([^"]*)"/i', $attrs, $t) === 1 ? $t[1] : '',
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
            $open['to'] = $offset + $len;
            $out[] = $open;
            $open = null;
            $openDepth = -1;
        }
    }
    return $out;
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
