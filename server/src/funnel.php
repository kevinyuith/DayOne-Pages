<?php
/**
 * Funnel in "server mode": one step per response.
 *
 * The editor stores a slug's sub-pages as sibling <section data-dop-page="…">
 * in the body, and may mark the body with data-dop-funnel="server". In that
 * mode, this server delivers ONLY the current step — the other sections are
 * not even in the HTML — and the page runtime switches steps by setting the
 * `dop_step` cookie and reloading the same URL. The URL never changes; the
 * presell's source doesn't contain the main page.
 *
 * Steps: always Pre Lander (presell) → Lander (main) → Backredirect; an
 * unknown kind counts as Lander. A step with no code (empty section, only
 * whitespace or a comment) is INACTIVE: it is never served. Same rules as the
 * editor (src/lib/pages/subpages.ts) and the runtime.
 *
 * Current step: the cookie, if it points to an active step; otherwise the
 * initial one — 1) the Pre Lander, if active; 2) the Lander. The HTML's
 * data-dop-start doesn't decide.
 *
 * What the runtime needs to know about the steps that didn't come goes as
 * attributes on the <body>: data-dop-cur, data-dop-next, data-dop-main,
 * data-dop-start, data-dop-br, data-dop-br-trigger.
 *
 * No DOMDocument (avoids depending on ext/xml): the sections are found by a
 * <section>/<\/section> counter. Before counting, comments, <script>,
 * <style> and <template> are blanked in a COPY (same length, same offsets),
 * so a "</section>" inside them doesn't count. A step is the first
 * <section data-dop-page> opened outside another step, at any depth (the
 * editor accepts steps wrapped in a plain <section>); it closes when the
 * depth goes back to the opening depth. The content of each step is left
 * intact.
 *
 * SAMPLES (A/B test, see ab_apply): before anything else, each step with two
 * or more active samples (sections of the same kind) keeps ONE, drawn in
 * proportion to the data-dop-weight values and fixed per visitor in the
 * dop_ab cookie. The others are removed from the HTML — in any mode, not only
 * server mode.
 *
 * Without server mode, returns null and the HTML goes as is. Server mode with
 * no step found also returns null, but logs it: it's a sign of HTML the
 * tokenizer didn't understand. With no active step, null (nothing to cut).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const FUNNEL_COOKIE = 'dop_step';
/** A/B test cookie: "<visitor 16 hex>:<id>,<id>…" — the samples drawn for them. */
const AB_COOKIE = 'dop_ab';
const AB_MAX_IDS = 24;
const AB_DEFAULT_WEIGHT = 50;

/** Does the HTML have step sections? (cheap: one regex) */
function funnel_has_sections(string $html): bool
{
    return preg_match('/<section\b[^>]*\bdata-dop-page\s*=/i', $html) === 1;
}

/** Does the body ask for server mode? (cheap: one regex on the HTML) */
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
        error_log('[dayone-pages] server-mode funnel with no recognized step; serving the whole HTML');
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

    // "Next": from the Pre Lander, the Lander; from the Lander, none; from the
    // Backredirect (or a section outside the flow), the Lander — or the initial one.
    if ($pre !== null && $cur['id'] === $pre['id']) {
        $next = $main;
    } elseif ($main !== null && $cur['id'] === $main['id']) {
        $next = null;
    } else {
        $next = $main ?? $start;
    }

    // Remove the other sections, from end to start (the offsets stay valid).
    $out = $html;
    foreach (array_reverse($pages) as $p) {
        if ($p['id'] !== $cur['id']) {
            $out = substr($out, 0, $p['from']) . substr($out, $p['to']);
        }
    }

    // The served step can't be `hidden` (the attribute is the browser mode's no-JS fallback).
    $out = funnel_unhide($out, $cur['id']);

    $esc = fn (string $v): string => htmlspecialchars($v, ENT_QUOTES, 'UTF-8');
    $attrs = ' data-dop-cur="' . $esc($cur['id']) . '"'
        . ' data-dop-start="' . $esc($start['id']) . '"'
        . ($next ? ' data-dop-next="' . $esc($next['id']) . '"' : '')
        . ($main ? ' data-dop-main="' . $esc($main['id']) . '"' : '')
        . ($br ? ' data-dop-br="' . $esc($br['id']) . '" data-dop-br-trigger="' . $esc($br['trigger']) . '"' : '');
    // Callback, not a replacement string: a "$1" or "\" in an attribute value doesn't become a backreference.
    $out = preg_replace_callback('/<body\b([^>]*)>/i', fn ($m) => '<body' . $m[1] . $attrs . '>', $out, 1) ?? $out;

    return ['html' => $out, 'step' => $cur['id']];
}

/**
 * The step sections, in document order, with the offsets into the ORIGINAL HTML.
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
    $open = null;      // the open step
    $openDepth = -1;   // depth at which it opened
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

/** Removes `hidden` from section `id`. Covers hidden, hidden="", hidden='', hidden=hidden, hidden="hidden". */
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
 * A/B test: in each step with two or more ACTIVE samples, one stays — the one
 * the dop_ab cookie already has for this visitor, otherwise one drawn in
 * proportion to the weights (all 0 = equal shares). The others are removed
 * from the HTML.
 *
 * `tag` goes into the ETag (each combination is a different body at the same
 * URL); `cookie` is the new dop_ab value, or null if it didn't change.
 * `$rand(max)` returns an integer in [0, max) — the tests pass a fixed one.
 *
 * @return array{html: string, tag: string, cookie: ?string}|null  null = no steps
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
        // Weight 0 = paused sample: not even visitors who already landed on it stay.
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
    // The drawn sample of the initial step stays visible without JS (the editor marked the first one).
    $startKind = isset($byKind['presell']) ? 'presell' : 'main';
    foreach ($chosen as $id) {
        foreach ($byKind[$startKind] ?? [] as $v) {
            if ($v['id'] === $id) {
                $out = funnel_unhide($out, $id);
            }
        }
    }
    // No test on this page: nothing to remember for the visitor.
    if ($chosen === []) {
        return ['html' => $out, 'tag' => '', 'cookie' => null];
    }

    // Cookie: the visitor (new, if there was none) + the samples drawn here + those from other pages.
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
 * "<16 hex>:<id>,<id>" → [visitor, ids]. Malformed value → [null, []].
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

/** Draws a sample in proportion to the weights (all 0 = equal shares). */
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

// ── A/B test between the pages of a funnel ─────────────────────────────────

/** Cookie of the draw between pages: the ids (uuid) of the domain pages already drawn for the visitor. */
const SPLIT_COOKIE = 'dop_pg';
const SPLIT_MAX_IDS = 10;

/**
 * The route resolved to a page that is a copy of a funnel page, and the
 * domain has other copies of the same funnel on the same path (`split`, from
 * pages.resolve): keep the one the dop_pg cookie already has for this visitor
 * (unless it is paused), otherwise one drawn by the weights (all 0 = equal
 * shares). Returns the route with the chosen page in its place and the new
 * cookie value (null = unchanged). Without split, the route comes back as is.
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
    foreach (['page_id', 'slug_id', 'content_type', 'content_hash', 'funnel', 'redirect'] as $k) {
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
 * A funnel redirect's destination: the stored URL TEMPLATE with every {name}
 * replaced by the visit's query param `name` (URL-encoded; missing = empty).
 * ONLY what the template names goes through — nothing else is appended.
 */
function funnel_redirect_url(string $template, string $rawQuery): string
{
    $q = [];
    parse_str($rawQuery, $q);
    return (string) (preg_replace_callback(
        '/\{([A-Za-z0-9_]{1,64})\}/',
        static function (array $m) use ($q): string {
            $v = $q[$m[1]] ?? '';
            return rawurlencode(is_scalar($v) ? (string) $v : '');
        },
        $template,
    ) ?? $template);
}

/**
 * Does a step's inner HTML have code? Comments, whitespace and &nbsp; don't
 * count (in the editor and the runtime, a text node with only whitespace/NBSP
 * doesn't either).
 */
function funnel_has_code(string $inner): bool
{
    return trim((string) preg_replace('/<!--.*?-->|&nbsp;|&#160;|&#xa0;|\xC2\xA0/is', '', $inner)) !== '';
}

/**
 * Copy of the HTML with comments, <script>, <style> and <template> replaced by
 * spaces — same length, so every offset found in it is valid in the original.
 * A "</section>" inside a comment or a JS string no longer counts.
 */
function funnel_blank_opaque(string $html): string
{
    return preg_replace_callback(
        '/<!--.*?-->|<(script|style|template)\b[^>]*>.*?<\/\1\s*>/is',
        fn ($m) => str_repeat(' ', strlen($m[0])),
        $html,
    ) ?? $html;
}
