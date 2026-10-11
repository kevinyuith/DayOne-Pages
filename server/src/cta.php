<?php
/**
 * The funnel's CTA under the VSL (pages.cta — the owner's plan of 11/10/2026):
 * the block of bundles, drawn by THIS server when the VSL reaches the pitch,
 * not when the page opens, so the draw counts only who got there.
 *
 * pages.resolve gives a funnel with CTAs on (pages.funnels.cta_enabled; only
 * F8 for now) its published CTAs (`ctas`: [{ id, weight, content_hash }]) and
 * marks its VSLs on CTA mode "server" (`cta: true` in the funnel's `vsl`); the
 * gate copies both to the funnel route (rules.php). A funnel page the gate
 * served whose drawn video is one of those (cta_page_mode) gets:
 *   * the tracker with &cta=1: dot.js asks /_dop/cta for the CTA at the pitch
 *     and puts it under the player — &cta=2 when the visitor already got one of
 *     this funnel's live CTAs (dop_cta): dot.js asks at once, as VTurb shows its
 *     CTA to a returning viewer;
 *   * the CTA with the largest share as a reserve, in a
 *     <template data-dop-cta-reserve> before </body> (inert: nothing loads),
 *     for when /_dop/cta doesn't answer — shown without a cta_id (it wasn't drawn).
 * A page with a tracker tag of its own gets no dot.js from us (track.php), so
 * nobody would ask for the CTA: it gets the reserve straight in the slot instead
 * (no draw, no cta_id) — a VSL on "server" never shows without a CTA.
 *
 * GET /_dop/cta?page=<page id>&video=<video id> (handle_cta) checks both
 * against the gate's data (the page is in a funnel's live split; the video is
 * that funnel's and on "server"), keeps the CTA dop_cta already has for this
 * funnel while it's live, otherwise draws one by the shares, and answers
 * { cta_id, html } (no-store); 204 when there is nothing to show. Nothing is
 * logged here: the record is dot's (dot.js sends cta_id from the video_pitch on).
 *
 * The HTML is content-addressed like a page's: the content cache by its hash
 * (a hash never changes content), pages.cta_content_get only when it isn't on
 * disk — /_dop/cta waits for it (the pitch has 2 s); a page that wants it as the
 * reserve and doesn't have it fetches it after the response.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const CTA_PATH = '/_dop/cta';
/** Cookie of the CTA draw: the CTAs (pages.cta ids) already drawn for the visitor, this funnel's first. */
const CTA_COOKIE = 'dop_cta';
const CTA_MAX_IDS = 10;
/** How long /_dop/cta waits for an HTML that isn't on disk yet. */
const CTA_FETCH_TIMEOUT_MS = 1500;
const CTA_UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';

/**
 * The funnel route's CTAs that can be drawn: valid ids and hashes with a share above 0.
 *
 * @return list<array{id: string, weight: int, hash: string}>
 */
function cta_list(mixed $ctas): array
{
    $out = [];
    foreach (is_array($ctas) ? $ctas : [] as $c) {
        $id = is_array($c) ? ($c['id'] ?? null) : null;
        $hash = is_array($c) ? ($c['content_hash'] ?? null) : null;
        $w = is_array($c) && is_numeric($c['weight'] ?? null) ? (int) $c['weight'] : 0;
        if (is_string($id) && preg_match(CTA_UUID_RE, $id) === 1 && is_string($hash) && preg_match('/^[0-9a-f]{64}$/', $hash) === 1 && $w > 0) {
            $out[] = ['id' => $id, 'weight' => min($w, 100), 'hash' => $hash];
        }
    }
    return $out;
}

/** Is `$video` one of the route's VSLs on CTA mode "server"? */
function cta_video_on(mixed $vsl, ?string $video): bool
{
    if ($video === null || $video === '') {
        return false;
    }
    foreach (is_array($vsl) ? $vsl : [] as $v) {
        if (is_array($v) && ($v['id'] ?? null) === $video && ($v['cta'] ?? false) === true) {
            return true;
        }
    }
    return false;
}

/** The CTA ids dop_cta holds (valid ones only). @return list<string> */
function cta_cookie_ids(array $cookies): array
{
    $raw = (string) ($cookies[CTA_COOKIE] ?? '');
    $ids = $raw === '' ? [] : explode(',', $raw);
    return array_values(array_filter($ids, static fn (string $id): bool => preg_match(CTA_UUID_RE, $id) === 1));
}

/**
 * The visitor's CTA: the one dop_cta already has among `$ctas`, otherwise one
 * drawn by the shares. `cookie` is the new dop_cta value, or null if it didn't
 * change. `$rand(max)` returns an integer in [0, max) — the tests pass a fixed one.
 *
 * @param list<array{id: string, weight: int, hash: string}> $ctas  non-empty (cta_list)
 * @return array{pick: array{id: string, weight: int, hash: string}, cookie: ?string}
 */
function cta_draw(array $ctas, array $cookies, ?callable $rand = null): array
{
    $known = cta_cookie_ids($cookies);
    $byId = array_column($ctas, null, 'id');
    $pick = null;
    foreach ($known as $id) {
        if (isset($byId[$id])) {
            $pick = $byId[$id];
            break;
        }
    }
    $pick ??= ab_pick($ctas, $rand);
    $keep = array_values(array_filter($known, static fn (string $id): bool => !isset($byId[$id])));
    $value = implode(',', array_slice([$pick['id'], ...$keep], 0, CTA_MAX_IDS));
    return ['pick' => $pick, 'cookie' => $value === (string) ($cookies[CTA_COOKIE] ?? '') ? null : $value];
}

function cta_cookie(string $value): string
{
    return CTA_COOKIE . "=$value; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax";
}

/** The CTA with the largest share (the first on a tie): the reserve. */
function cta_reserve(array $ctas): ?array
{
    $best = null;
    foreach ($ctas as $c) {
        if ($best === null || $c['weight'] > $best['weight']) {
            $best = $c;
        }
    }
    return $best;
}

/**
 * What a funnel page the gate served gets for the CTA: null = nothing (the
 * drawn video isn't on "server", or the funnel has no live CTA). `mode` is the
 * tracker's &cta= (1 = ask at the pitch, 2 = the visitor already got a live one:
 * ask at once); `reserve` is the reserve CTA (null when its HTML isn't on disk:
 * it's fetched after the response).
 *
 * @return array{mode: int, reserve: ?array{id: string, weight: int, hash: string}, reserve_html: ?string}|null
 */
function cta_page_mode(array $route, ?string $video, array $cookies): ?array
{
    $ctas = cta_list($route['ctas'] ?? null);
    if ($ctas === [] || !cta_video_on($route['vsl'] ?? null, $video)) {
        return null;
    }
    $live = array_column($ctas, 'id');
    $returning = array_intersect(cta_cookie_ids($cookies), $live) !== [];
    $reserve = cta_reserve($ctas);
    $html = $reserve !== null ? cache_read_content($reserve['hash']) : null;
    if ($reserve !== null && $html === null) {
        cta_prefetch_later($reserve);
    }
    return ['mode' => $returning ? 2 : 1, 'reserve' => $html !== null ? $reserve : null, 'reserve_html' => $html];
}

/** The reserve, inert, before </body> (or at the end): dot.js shows it when /_dop/cta doesn't answer. */
function cta_reserve_inject(string $html, string $ctaHtml): string
{
    $tpl = '<template data-dop-cta-reserve>' . $ctaHtml . '</template>';
    $pos = strripos($html, '</body>');
    return $pos === false ? $html . $tpl : substr_replace($html, $tpl, $pos, 0);
}

/**
 * The reserve straight in the slot, for a page that gets no tracker from us (it
 * has one of its own): into <div data-dop-cta>, or right after the VTurb player.
 */
function cta_slot_inject(string $html, string $ctaHtml): string
{
    $block = '<div data-dop-cta data-dop-cta-shown="reserve">' . $ctaHtml . '</div>';
    if (preg_match('/<div\b[^>]*\bdata-dop-cta\b[^>]*>\s*<\/div>/i', $html, $m, PREG_OFFSET_CAPTURE) === 1) {
        return substr_replace($html, $block, (int) $m[0][1], strlen($m[0][0]));
    }
    $pos = stripos($html, '</vturb-smartplayer>');
    if ($pos !== false) {
        return substr_replace($html, $block, $pos + strlen('</vturb-smartplayer>'), 0);
    }
    return cta_reserve_inject($html, $ctaHtml);
}

/** The CTAs whose HTML a page wanted but didn't have on disk: fetched after the response (cta_prefetch_pending). */
function cta_prefetch_later(?array $cta): array
{
    static $pending = [];
    if ($cta !== null) {
        $pending[$cta['id']] = $cta;
    }
    return $pending;
}

/**
 * A CTA's HTML: from the content cache by its hash; with `$fetch`, from the
 * database when it isn't on disk (stored by the hash the database has now —
 * newer than the resolve's if the CTA changed in between). null = not available.
 */
function cta_html(array $cta, bool $fetch, ?callable $get = null): ?string
{
    $html = cache_read_content($cta['hash']);
    if ($html !== null || !$fetch) {
        return $html;
    }
    $get ??= static fn (array $ids): array => supabase_rpc('cta_content_get', ['p_ids' => $ids], CTA_FETCH_TIMEOUT_MS);
    $r = $get([$cta['id']]);
    if (!($r['ok'] ?? false)) {
        error_log('[dayone-pages] cta_content_get failed: ' . ($r['error'] ?? '?'));
        return null;
    }
    foreach ((array) ($r['rows'] ?? []) as $row) {
        if (is_array($row) && ($row['cta_id'] ?? null) === $cta['id'] && is_string($row['html'] ?? null)
            && is_string($row['content_hash'] ?? null) && $row['html'] !== '') {
            cache_put_content($row['content_hash'], $row['html']);
            return $row['html'];
        }
    }
    return null;
}

/** After a response: the reserve HTML the pages wanted, onto disk. */
function cta_prefetch_pending(): void
{
    foreach (cta_prefetch_later(null) as $cta) {
        cta_html($cta, true);
    }
}

/**
 * The funnel whose live split has `$pageId`, from the gate's data: [code, funnel] or null.
 *
 * @return array{0: string, 1: array}|null
 */
function cta_funnel_of_page(mixed $gate, string $pageId): ?array
{
    foreach (is_array($gate['funnels'] ?? null) ? $gate['funnels'] : [] as $code => $funnel) {
        foreach (is_array($funnel['split'] ?? null) ? $funnel['split'] : [] as $c) {
            if (is_array($c) && ($c['page_id'] ?? null) === $pageId) {
                return [(string) $code, $funnel];
            }
        }
    }
    return null;
}

/**
 * GET /_dop/cta?page=&video= on any domain. null = not this path.
 * `$gateOf(host)` returns the host's gate data (the tests pass a fake one);
 * `$get` fetches HTML that isn't on disk (the tests too).
 *
 * @return array{0: int, 1: array<string,mixed>, 2: ?string}|null
 */
function handle_cta(Request $req, ?callable $gateOf = null, ?callable $get = null, ?callable $rand = null): ?array
{
    if ($req->rawPath !== CTA_PATH) {
        return null;
    }
    $headers = ['Cache-Control' => 'no-store', 'X-Robots-Tag' => 'noindex', 'X-Content-Type-Options' => 'nosniff'];
    if ($req->method !== 'GET') {
        return [405, $headers + ['Allow' => 'GET', 'Content-Type' => 'text/plain; charset=utf-8'], "Method not allowed\n"];
    }
    parse_str($req->rawQuery, $q);
    $pageId = is_string($q['page'] ?? null) ? $q['page'] : '';
    $video = is_string($q['video'] ?? null) ? $q['video'] : '';
    if (preg_match(CTA_UUID_RE, $pageId) !== 1 || preg_match('/^[0-9a-f]{24}$/', $video) !== 1) {
        return [204, $headers, null];
    }
    $host = normalize_host($req->rawHost);
    if (!is_valid_host($host)) {
        return [204, $headers, null];
    }
    $gateOf ??= static function (string $host): ?array {
        $resolved = resolve_routes($host, '/');
        return is_array($resolved['gate'] ?? null) ? $resolved['gate'] : null;
    };
    $found = cta_funnel_of_page($gateOf($host), $pageId);
    if ($found === null) {
        return [204, $headers, null];
    }
    [, $funnel] = $found;
    $ctas = cta_list($funnel['ctas'] ?? null);
    if ($ctas === [] || !cta_video_on($funnel['vsl'] ?? null, $video)) {
        return [204, $headers, null];
    }
    ['pick' => $pick, 'cookie' => $cookie] = cta_draw($ctas, $req->cookies, $rand);
    $html = cta_html($pick, true, $get);
    if ($html === null) {
        return [503, $headers + ['Retry-After' => '5'], null];
    }
    cache_touch_content($pick['hash']);
    if ($cookie !== null) {
        $headers['Set-Cookie'] = [cta_cookie($cookie)];
    }
    $body = json_encode(['cta_id' => $pick['id'], 'html' => $html], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return [200, $headers + ['Content-Type' => 'application/json; charset=utf-8'], $body === false ? '{}' : $body];
}
