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
 * Sem modo servidor, devolve null e o HTML vai como está. Modo servidor sem
 * nenhuma etapa encontrada também devolve null, mas registra no log: é sinal
 * de HTML que o tokenizador não entendeu. Sem etapa ativa, null (nada a cortar).
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
 * @return list<array{id: string, kind: string, start: bool, trigger: string, active: bool, from: int, to: int}>
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
