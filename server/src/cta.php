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
 * THE TEST LINK (the owner, 11/10: CTAs tested before they go live): ?dop_cta=<cta id> on a
 * funnel page the gate served gives the tracker &cta=3 — whatever the drawn video's mode —,
 * and dot.js asks /_dop/cta?…&preview=<id> at once: THAT CTA of the page's funnel, a draft
 * included (pages.cta_preview_get), under the player. Outside the draw: no dop_cta cookie, and
 * dot's events carry no cta_id (a test isn't a view of the CTA).
 *
 * The HTML is content-addressed like a page's: the content cache by its hash
 * (a hash never changes content), pages.cta_content_get only when it isn't on
 * disk — /_dop/cta waits for it (the pitch has 2 s); a page that wants it as the
 * reserve and doesn't have it fetches it after the response.
 *
 * BLOCKS AND PLACEMENTS (20261012a; the owner's plan of 11/10): what is drawn
 * comes from pages.cta_draw_get(page, video): the VSL's block — its custom group
 * (listed, else by its offer's product) when that has something to show, else
 * the funnel's Default block, which may list library designs —, the designs the
 * VSL's offer can fill, and the offer. A design's {{cta.product}} and
 * {{cta.kit<N>.<field>}} are filled from that offer (HTML-escaped; the image
 * from the design's jar style when the product has that photo) — one design
 * serves every product. The answer is kept on disk per page and video
 * (cache/cta/) and asked again after CACHE_TTL (30 s), like the routes; when
 * Supabase doesn't answer, the expired copy (up to STALE_MAX_AGE), and with no
 * copy at all, the resolve's Default CTAs that need no offer. The page render
 * never waits for it: it reads the copy on disk (the reserve) and refreshes it
 * after the response.
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
/** The page's query parameter of the test link: ?dop_cta=<cta id>. */
const CTA_PREVIEW_PARAM = 'dop_cta';
/** A placement in a CTA design: {{cta.product}}, {{cta.kit6.price}}… (pages.cta_placements_of). */
const CTA_PLACEMENT_RE = '/\{\{\s*cta\.([A-Za-z0-9_.]*)\s*\}\}/';

/**
 * The CTAs that can be drawn (the route's, or a block's from pages.cta_draw_get):
 * valid ids and hashes with a share above 0, with the design's jar style.
 *
 * @return list<array{id: string, weight: int, hash: string, jar_style: ?string}>
 */
function cta_list(mixed $ctas): array
{
    $out = [];
    foreach (is_array($ctas) ? $ctas : [] as $c) {
        $id = is_array($c) ? ($c['id'] ?? null) : null;
        $hash = is_array($c) ? ($c['content_hash'] ?? null) : null;
        $w = is_array($c) && is_numeric($c['weight'] ?? null) ? (int) $c['weight'] : 0;
        $jar = is_array($c) ? cta_jar_style($c['jar_style'] ?? null) : null;
        if (is_string($id) && preg_match(CTA_UUID_RE, $id) === 1 && is_string($hash) && preg_match('/^[0-9a-f]{64}$/', $hash) === 1 && $w > 0) {
            $out[] = ['id' => $id, 'weight' => min($w, 100), 'hash' => $hash, 'jar_style' => $jar];
        }
    }
    return $out;
}

/** A design's jar style (pages.cta.jar_style), or null. */
function cta_jar_style(mixed $style): ?string
{
    return is_string($style) && preg_match('/^[a-z0-9][a-z0-9_-]{0,39}$/', $style) === 1 ? $style : null;
}

/** The offer of an answer, or null: { product, kits: { "<N>": { field: string } }, jars: { style: { "<N>": url } } }. */
function cta_offer(mixed $offer): ?array
{
    if (!is_array($offer) || !is_string($offer['product'] ?? null) || !is_array($offer['kits'] ?? null)) {
        return null;
    }
    return ['product' => $offer['product'], 'kits' => $offer['kits'], 'jars' => is_array($offer['jars'] ?? null) ? $offer['jars'] : []];
}

/** Does the HTML have placements to fill? */
function cta_has_placements(string $html): bool
{
    return str_contains($html, '{{') && preg_match(CTA_PLACEMENT_RE, $html) === 1;
}

/** One placement's value from the offer ('' when it has none). */
function cta_placement_value(string $key, ?array $offer, ?string $jarStyle): string
{
    if ($offer === null) {
        return '';
    }
    if ($key === 'product') {
        return $offer['product'];
    }
    if (preg_match('/^kit([1-9][0-9]?)\.([a-z_]+)$/', $key, $k) !== 1) {
        return '';
    }
    if ($k[2] === 'image' && $jarStyle !== null) {
        $photo = $offer['jars'][$jarStyle][$k[1]] ?? null;
        if (is_string($photo) && $photo !== '') {
            return $photo;
        }
    }
    $kit = $offer['kits'][$k[1]] ?? null;
    $value = is_array($kit) ? ($kit[$k[2]] ?? null) : null;
    return is_string($value) ? $value : '';
}

/** The design with its placements filled from the VSL's offer, HTML-escaped. */
function cta_fill(string $html, ?array $offer, ?string $jarStyle = null): string
{
    if (!cta_has_placements($html)) {
        return $html;
    }
    $filled = preg_replace_callback(
        CTA_PLACEMENT_RE,
        static fn (array $m): string => htmlspecialchars(cta_placement_value($m[1], $offer, $jarStyle), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'),
        $html,
    );
    return $filled ?? $html;
}

function cta_draw_file(string $pageId, string $video): string
{
    return cache_dir() . '/cta/' . sha1($pageId . '|' . $video) . '.php';
}

/**
 * A VSL's draw data, as stored: ['state' => 'ok', 'block', 'ctas', 'offer', 'stored_at']
 * or ['state' => 'none', 'stored_at'] (the database said there's nothing). null = not valid.
 */
function cta_draw_normalize(mixed $d): ?array
{
    if (!is_array($d) || !is_int($d['stored_at'] ?? null) || !in_array($d['state'] ?? null, ['ok', 'none'], true)) {
        return null;
    }
    if ($d['state'] === 'none') {
        return ['state' => 'none', 'stored_at' => $d['stored_at']];
    }
    return ['state' => 'ok', 'block' => is_string($d['block'] ?? null) ? $d['block'] : 'default', 'ctas' => cta_list($d['ctas'] ?? null),
            'offer' => cta_offer($d['offer'] ?? null), 'stored_at' => $d['stored_at']];
}

/** The VSL's draw data on disk, or null. */
function cta_draw_read(string $pageId, string $video): ?array
{
    $raw = @file_get_contents(cta_draw_file($pageId, $video));
    $json = $raw === false ? null : cache_unwrap($raw);
    return $json === null ? null : cta_draw_normalize(json_decode($json, true));
}

/**
 * The VSL's draw data from the database (pages.cta_draw_get: one row, or none =
 * nothing to show), stored on disk. null = the database didn't answer. `$get` is
 * the call (the tests pass a fake one).
 */
function cta_draw_fetch(string $pageId, string $video, ?callable $get = null): ?array
{
    $get ??= static fn (string $page, string $vid): array => supabase_rpc('cta_draw_get', ['p_page' => $page, 'p_video' => $vid], CTA_FETCH_TIMEOUT_MS);
    $r = $get($pageId, $video);
    if (!($r['ok'] ?? false)) {
        error_log('[dayone-pages] cta_draw_get failed: ' . ($r['error'] ?? '?'));
        return null;
    }
    $row = ((array) ($r['rows'] ?? []))[0] ?? null;
    // Stored as the database said it (the read normalizes it again).
    $stored = is_array($row) ? ['state' => 'ok', 'stored_at' => time()] + $row : ['state' => 'none', 'stored_at' => time()];
    $json = json_encode($stored, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json !== false) {
        atomic_write(cta_draw_file($pageId, $video), cache_wrap($json));
    }
    return cta_draw_normalize($stored);
}

/**
 * The VSL's draw data: the copy on disk while fresh (CACHE_TTL); otherwise, with
 * `$fetch`, the database (waits up to CTA_FETCH_TIMEOUT_MS) — or the expired copy
 * when it doesn't answer, up to STALE_MAX_AGE. Without `$fetch` (the page render)
 * the copy on disk of any age up to STALE_MAX_AGE, and a stale or missing one is
 * refreshed after the response. null = nothing known.
 */
function cta_draw_data(string $pageId, string $video, bool $fetch, ?callable $get = null): ?array
{
    $cfg = config();
    $copy = cta_draw_read($pageId, $video);
    $age = $copy !== null ? time() - $copy['stored_at'] : PHP_INT_MAX;
    if ($copy !== null && $age < $cfg['cache_ttl']) {
        return $copy;
    }
    $usable = $copy !== null && $age <= $cfg['stale_max_age'] ? $copy : null;
    if (!$fetch) {
        cta_draw_later($pageId, $video);
        return $usable;
    }
    return cta_draw_fetch($pageId, $video, $get) ?? $usable;
}

/** The (page, video) whose draw data a page wanted fresh: fetched after the response (cta_prefetch_pending). */
function cta_draw_later(?string $pageId, ?string $video = null): array
{
    static $pending = [];
    if ($pageId !== null && $video !== null) {
        $pending[$pageId . '|' . $video] = [$pageId, $video];
    }
    return $pending;
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

/** The test link's CTA id in the page's query (?dop_cta=<id>), or null. */
function cta_preview_id(string $rawQuery): ?string
{
    parse_str($rawQuery, $q);
    $id = $q[CTA_PREVIEW_PARAM] ?? null;
    return is_string($id) && preg_match(CTA_UUID_RE, $id) === 1 ? $id : null;
}

/**
 * What a funnel page the gate served gets for the CTA: null = nothing (the
 * drawn video isn't on "server", or the VSL's block has nothing it can show).
 * `mode` is the tracker's &cta= (1 = ask at the pitch, 2 = the visitor already
 * got one of the block's live CTAs: ask at once, 3 = the test link: that CTA at
 * once, outside the draw); `reserve` is the reserve CTA and `reserve_html` its
 * HTML, filled with the VSL's offer (null when it isn't on disk: fetched after
 * the response; none on the test link); `tag` goes into the ETag.
 *
 * The block comes from the VSL's draw data on disk (cta_draw_data, never waited
 * for here); with no copy yet, the resolve's Default CTAs — a reserve that needs
 * an offer is then left out, and dot.js still asks at the pitch.
 *
 * @return array{mode: int, reserve: ?array{id: string, weight: int, hash: string, jar_style: ?string}, reserve_html: ?string, tag: string}|null
 */
function cta_page_mode(array $route, ?string $video, array $cookies, ?string $preview = null, ?string $pageId = null): ?array
{
    if ($preview !== null) {
        return ['mode' => 3, 'reserve' => null, 'reserve_html' => null, 'tag' => ''];
    }
    if (!cta_video_on($route['vsl'] ?? null, $video)) {
        return null;
    }
    $data = $pageId !== null ? cta_draw_data($pageId, (string) $video, false) : null;
    if ($data !== null && ($data['state'] === 'none' || $data['ctas'] === [])) {
        return null;
    }
    $ctas = $data !== null ? $data['ctas'] : cta_list($route['ctas'] ?? null);
    $offer = $data['offer'] ?? null;
    $live = array_column($ctas, 'id');
    $returning = array_intersect(cta_cookie_ids($cookies), $live) !== [];
    $reserve = cta_reserve($ctas);
    $html = $reserve !== null ? cache_read_content($reserve['hash']) : null;
    if ($reserve !== null && $html === null) {
        cta_prefetch_later($reserve);
    }
    $tag = '';
    if ($html !== null && cta_has_placements($html)) {
        $html = $offer !== null ? cta_fill($html, $offer, $reserve['jar_style']) : null;
        $tag = $offer !== null ? substr(md5((string) json_encode($offer)), 0, 6) : '';
    }
    $reserve = $html !== null ? $reserve : null;
    return ['mode' => $returning ? 2 : 1, 'reserve' => $reserve, 'reserve_html' => $html,
            'tag' => $reserve !== null ? substr($reserve['hash'], 0, 8) . $tag : ''];
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

/** After a response: the VSLs' draw data the pages wanted fresh, and the reserve HTML they wanted, onto disk. */
function cta_prefetch_pending(): void
{
    foreach (cta_draw_later(null) as [$pageId, $video]) {
        $d = cta_draw_fetch($pageId, $video);
        $reserve = $d !== null && $d['state'] === 'ok' ? cta_reserve($d['ctas']) : null;
        if ($reserve !== null && !cache_has_content($reserve['hash'])) {
            cta_prefetch_later($reserve);
        }
    }
    foreach (cta_prefetch_later(null) as $cta) {
        cta_html($cta, true);
    }
}

/** Forgets every VSL's draw data (a purge: the next draw asks the database). */
function cta_draw_purge(): int
{
    return remove_tree(cache_dir() . '/cta');
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
 * The test link's CTA: its HTML when it belongs to the funnel that lists `$pageId`
 * or to the library (pages.cta_preview_get — a draft included), stored by its hash
 * and filled with `$video`'s offer when that is a VSL of the funnel. null = not
 * available. `$get` is the database call (the tests pass a fake one).
 */
function cta_preview_html(string $ctaId, string $pageId, string $video, ?callable $get = null): ?string
{
    $get ??= static fn (string $cta, string $page, string $vid): array => supabase_rpc('cta_preview_get', ['p_cta' => $cta, 'p_page' => $page, 'p_video' => $vid], CTA_FETCH_TIMEOUT_MS);
    $r = $get($ctaId, $pageId, $video);
    if (!($r['ok'] ?? false)) {
        error_log('[dayone-pages] cta_preview_get failed: ' . ($r['error'] ?? '?'));
        return null;
    }
    foreach ((array) ($r['rows'] ?? []) as $row) {
        if (is_array($row) && ($row['cta_id'] ?? null) === $ctaId && is_string($row['html'] ?? null) && $row['html'] !== '') {
            if (is_string($row['content_hash'] ?? null) && preg_match('/^[0-9a-f]{64}$/', $row['content_hash']) === 1) {
                cache_put_content($row['content_hash'], $row['html']);
            }
            return cta_fill($row['html'], cta_offer($row['offer'] ?? null), cta_jar_style($row['jar_style'] ?? null));
        }
    }
    return null;
}

/**
 * GET /_dop/cta?page=&video= on any domain. null = not this path.
 * `$gateOf(host)` returns the host's gate data (the tests pass a fake one);
 * `$get` fetches HTML that isn't on disk (the tests too); `$previewGet` is the
 * test link's database call (&preview=<cta id>: that CTA, no draw, no cookie);
 * `$drawGet` is pages.cta_draw_get (the VSL's block, its designs and offer).
 *
 * @return array{0: int, 1: array<string,mixed>, 2: ?string}|null
 */
function handle_cta(Request $req, ?callable $gateOf = null, ?callable $get = null, ?callable $rand = null, ?callable $previewGet = null, ?callable $drawGet = null): ?array
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
    $preview = is_string($q['preview'] ?? null) && preg_match(CTA_UUID_RE, $q['preview']) === 1 ? $q['preview'] : null;
    if ($preview !== null) {
        // The test link: that CTA (the page's funnel's or the library's, a draft too), whatever the video's mode,
        // filled with the video's offer; no draw, no cookie.
        $html = cta_preview_html($preview, $pageId, $video, $previewGet);
        if ($html === null) {
            return [204, $headers, null];
        }
        $body = json_encode(['cta_id' => $preview, 'html' => $html, 'preview' => true], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        return [200, $headers + ['Content-Type' => 'application/json; charset=utf-8'], $body === false ? '{}' : $body];
    }
    [, $funnel] = $found;
    if (!cta_video_on($funnel['vsl'] ?? null, $video)) {
        return [204, $headers, null];
    }
    $data = cta_draw_data($pageId, $video, true, $drawGet);
    if ($data !== null && $data['state'] === 'none') {
        return [204, $headers, null];
    }
    if ($data !== null) {
        $ctas = $data['ctas'];
        $offer = $data['offer'];
    } else {
        // Supabase doesn't answer and there's no copy: the resolve's Default CTAs that are on disk and need no offer.
        $ctas = array_values(array_filter(cta_list($funnel['ctas'] ?? null), static function (array $c): bool {
            $html = cache_read_content($c['hash']);
            return $html !== null && !cta_has_placements($html);
        }));
        $offer = null;
        if ($ctas === []) {
            return [503, $headers + ['Retry-After' => '5'], null];
        }
    }
    if ($ctas === []) {
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
    $body = json_encode(['cta_id' => $pick['id'], 'html' => cta_fill($html, $offer, $pick['jar_style'])], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return [200, $headers + ['Content-Type' => 'application/json; charset=utf-8'], $body === false ? '{}' : $body];
}
