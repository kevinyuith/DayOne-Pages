<?php
/**
 * A vendor page's upsell funnel (pages.upsell_funnels, the dashboard's Upsells
 * menu): the steps after the checkout — Upsell 1…5 and the Thank you page — of
 * a vendor page (scope VENDOR) served by its domain. The live config comes in
 * resolve's gate (`upsell`, by vendor page id, with `pages`: each upsell page
 * its versions name, with its served slug and hash); this file turns a request
 * for a step's path into the version this buyer gets — before the gate, so the
 * gate's "domain page at this slug" is that version. Tested in server/tests/upsell.test.php.
 *
 * For an upsell step (up1…up5), in order:
 *   1. the GROUP: what the buyer bought at the front, from the funnel's
 *      `front_param` URL parameter (?front=6), against each group's `fronts`;
 *      no group names it → the group with no fronts (any other), else the first;
 *   2. the FLOW: the funnel's flows in order, the first whose `when` matches the
 *      request (the base conditions of the rules, conditions.php, plus `cookies`);
 *      none → "default";
 *   3. the PAGE VERSION of that group and flow (default when the flow has none),
 *      by weight: an upsell page (scope VENDOR, kind UPSELL, the vendor page's
 *      product and platform — 20261014d), served at the step's path. The routing
 *      is internal: the paths are fixed (/up1 … /up5, /thank-you) and the vendor
 *      page needs no slug there (with no version to serve, its own slug at that
 *      path, if it has one; else 404);
 *   4. the CTA (the offer: a checkout key of the product) and one version of each
 *      downsell slot, by weight: their checkout values fill {{upsell.offer}} and
 *      {{upsell.downsell1}}, {{upsell.downsell2}}… in the page (the downsells run
 *      on the same page: its own markup shows them on a decline);
 *   5. the group's VSL videos go to the VSL draw (vsl.php, {{video_id}}).
 * Every pick is by weight and the same for the same visitor (a hash of the
 * `dop_uv` cookie, 30 days, and what is being picked), so a refresh or a return
 * shows the same versions; a changed share moves only some visitors.
 *
 * Both kinds of step (the Thank you page too) get the vendor's tracker (dot.js,
 * origin vendor_up1…vendor_up5 / vendor_thank_you: a page_view per step and the
 * buyer's accept/decline clicks, track.php) and the hit records what was served
 * (pages.hits.upsell).
 *
 * A step is served at its canonical path AND at its ALIASES (20261015c; the
 * owner, 15/10: keep the URLs already registered on the platforms): implicitly
 * at the vendor page's folder + its path (resolve's gate.vendor: a page whose
 * slugs all live under /bg serves its Upsell 1 at /bg/up1 too), and at the
 * step's own `aliases` (/bg/up1v2). The route keeps the requested path as its
 * slug. When two vendor pages of the domain claim the same path, the one whose
 * folder holds it wins (/bg/up1 → the /bg page's funnel; /up1 → the root page's).
 * The gate lets an alias reach the funnel like its step (rules.php).
 *
 * The vendor page's LANDING — the route at its folder's root ("/", "/bg") —
 * gets the same tracker as origin vendor_front (vendor_route_mark) and the load
 * notice; on every vendor route with the tracker, its URL also carries the
 * product's core id (&product_id=, &step=: resolve's gate.vendor, 20261015b/c).
 * Nothing of it applies to any other domain or page.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** The visitor key behind every upsell pick (random, 32 hex). */
const UPSELL_VISITOR_COOKIE = 'dop_uv';
const UPSELL_VISITOR_DAYS = 30;
/** The front parameter when the funnel names none. */
const UPSELL_FRONT_PARAM = 'front';
/** The tracker's origin for each step. */
const UPSELL_ORIGINS = [
    'up1' => 'vendor_up1', 'up2' => 'vendor_up2', 'up3' => 'vendor_up3', 'up4' => 'vendor_up4', 'up5' => 'vendor_up5',
    'ty' => 'vendor_thank_you',
];
/** content_get takes 50 refs a call: the versions an upsell may serve stay well under it. */
const UPSELL_MAX_REFS = 40;

/** The folder a vendor page lives in (resolve's gate.vendor: "/bg", or "" for the root — and for a cache from before it). */
function upsell_page_folder(?array $gate, string $pageId): string
{
    $folder = is_array($gate['vendor'][$pageId] ?? null) ? (string) ($gate['vendor'][$pageId]['folder'] ?? '') : '';
    return preg_match('~^/[a-z0-9._\~-]+$~', $folder) === 1 ? $folder : '';
}

/**
 * Every path a step is served at, lowercase: its canonical path, the implicit
 * alias in the vendor page's folder (/bg/up1) and its explicit aliases — the
 * same as stepPaths (src/lib/pages/vendor-paths.ts).
 *
 * @return list<string>
 */
function upsell_step_paths(array $step, string $folder): array
{
    $canonical = strtolower((string) ($step['slug'] ?? ''));
    $paths = $canonical !== '' ? [$canonical] : [];
    if ($folder !== '' && $canonical !== '') {
        $paths[] = strtolower($folder) . $canonical;
    }
    foreach ((array) ($step['aliases'] ?? []) as $alias) {
        if (is_string($alias) && $alias !== '') {
            $paths[] = strtolower($alias);
        }
    }
    return array_values(array_unique($paths));
}

/**
 * The funnel and step a route is on: the vendor page's funnel (gate.upsell, by
 * page id) whose step is served at this path (its canonical path or an alias).
 * null = not an upsell step.
 *
 * @return array{0: array, 1: array}|null
 */
function upsell_step(array $route, ?array $gate, string $path): ?array
{
    $pageId = (string) ($route['page_id'] ?? '');
    $funnel = is_array($gate['upsell'] ?? null) ? ($gate['upsell'][$pageId] ?? null) : null;
    if (!is_array($funnel)) {
        return null;
    }
    $folder = upsell_page_folder($gate, $pageId);
    $path = strtolower($path);
    foreach ((array) ($funnel['steps'] ?? []) as $step) {
        if (is_array($step) && isset(UPSELL_ORIGINS[$step['id'] ?? '']) && in_array($path, upsell_step_paths($step, $folder), true)) {
            return [$funnel, $step];
        }
    }
    return null;
}

/**
 * How strongly a vendor page owns a path, when two of the domain's funnels claim
 * it: 2 = the path is in its folder (/bg/… for the /bg page), 1 = it lives at the
 * root, 0 = it lives in another folder.
 */
function upsell_folder_rank(string $folder, string $path): int
{
    if ($folder === '') {
        return 1;
    }
    return str_starts_with(strtolower($path), strtolower($folder) . '/') ? 2 : 0;
}

/**
 * The canonical path of the upsell step this path is served at — itself, or an
 * alias of it — on any of the domain's funnels (the one whose page's folder holds
 * it first); null = no step. The gate allows an alias like its step.
 */
function upsell_step_canonical(?array $gate, string $path): ?string
{
    $best = null;
    $rank = -1;
    foreach ((array) ($gate['upsell'] ?? []) as $pageId => $funnel) {
        if (!is_array($funnel)) {
            continue;
        }
        $found = upsell_step(['page_id' => (string) $pageId], $gate, $path);
        $r = $found !== null ? upsell_folder_rank(upsell_page_folder($gate, (string) $pageId), $path) : -1;
        if ($found !== null && $r > $rank) {
            [$best, $rank] = [strtolower((string) ($found[1]['slug'] ?? '')), $r];
        }
    }
    return $best;
}

/**
 * The visitor's key: the dop_uv cookie, or a new one (and its Set-Cookie).
 *
 * @return array{0: string, 1: ?string}
 */
function upsell_visitor(array $cookies): array
{
    $raw = (string) ($cookies[UPSELL_VISITOR_COOKIE] ?? '');
    if (preg_match('/^[0-9a-f]{32}$/', $raw) === 1) {
        return [$raw, null];
    }
    $id = bin2hex(random_bytes(16));
    return [$id, UPSELL_VISITOR_COOKIE . '=' . $id . '; Path=/; Max-Age=' . (UPSELL_VISITOR_DAYS * 86400) . '; HttpOnly; Secure; SameSite=Lax'];
}

/**
 * One item by weight (0–100; 0 = paused), the same for the same seed. null =
 * nothing to pick. All weights 0 → the first.
 */
function upsell_weighted(array $items, string $seed): ?array
{
    $items = array_values(array_filter($items, 'is_array'));
    if ($items === []) {
        return null;
    }
    $weights = array_map(static fn(array $i): int => max(0, min(100, (int) round((float) ($i['weight'] ?? 0)))), $items);
    $total = array_sum($weights);
    if ($total === 0) {
        return $items[0];
    }
    $n = hexdec(substr(hash('sha256', $seed), 0, 12)) % $total;
    foreach ($items as $i => $item) {
        if ($n < $weights[$i]) {
            return $item;
        }
        $n -= $weights[$i];
    }
    return $items[count($items) - 1];
}

/** The step's group for what the buyer bought (the front parameter's value). */
function upsell_group(array $step, string $front): ?array
{
    $groups = array_values(array_filter((array) ($step['groups'] ?? []), 'is_array'));
    $any = null;
    foreach ($groups as $g) {
        $fronts = array_map('strval', (array) ($g['fronts'] ?? []));
        if ($fronts === []) {
            $any ??= $g;
        } elseif ($front !== '' && in_array($front, $fronts, true)) {
            return $g;
        }
    }
    return $any ?? ($groups[0] ?? null);
}

/** Do the request's cookies match a flow's `cookies` ({name: present|absent|empty|{equals}})? */
function upsell_cookies_match(array $want, array $cookies): bool
{
    foreach ($want as $name => $rule) {
        $has = array_key_exists((string) $name, $cookies);
        $value = $has ? (string) $cookies[(string) $name] : '';
        $ok = match (true) {
            $rule === 'present' => $has,
            $rule === 'absent' => !$has,
            $rule === 'empty' => $value === '',
            is_array($rule) && isset($rule['equals']) => $has && $value === (string) $rule['equals'],
            default => false,
        };
        if (!$ok) {
            return false;
        }
    }
    return true;
}

/** The flow this request takes: the first whose `when` matches, else "default". */
function upsell_flow(array $funnel, Request $req): string
{
    foreach ((array) ($funnel['flows'] ?? []) as $flow) {
        if (!is_array($flow) || !is_string($flow['id'] ?? null)) {
            continue;
        }
        $when = is_array($flow['when'] ?? null) ? $flow['when'] : [];
        $cookies = is_array($when['cookies'] ?? null) ? $when['cookies'] : [];
        unset($when['cookies']);
        if (upsell_cookies_match($cookies, $req->cookies) && conditions_match($when, $req)) {
            return $flow['id'];
        }
    }
    return 'default';
}

/** The front parameter's value in the request's query ('' when absent). */
function upsell_front(array $funnel, string $rawQuery): string
{
    $name = (string) ($funnel['front_param'] ?? UPSELL_FRONT_PARAM);
    parse_str($rawQuery, $q);
    $v = $q[$name] ?? '';
    return is_string($v) ? trim($v) : '';
}

/**
 * The routes with the upsell step applied (see the top of the file): the route
 * of the vendor page whose funnel has a step at this path becomes the version
 * this buyer gets and goes first, so the gate's domain page at this slug is it.
 * When several vendor pages' funnels claim the path, the page whose folder holds
 * it wins (upsell_folder_rank; a tie keeps the routes' order). Any other
 * request's routes come back unchanged, and so do they when the step has nothing
 * to serve (no version and no slug of the vendor page there: 404).
 *
 * @return array{0: array, 1: ?string} the routes, and the visitor cookie to set (null = none)
 */
function upsell_routes(array $routes, ?array $gate, Request $req): array
{
    $best = null;
    foreach ($routes as $i => $route) {
        if (!is_array($route) || ($route['action'] ?? '') !== 'SERVE') {
            continue;
        }
        $found = upsell_step($route, $gate, $req->path);
        if ($found === null) {
            continue;
        }
        $rank = upsell_folder_rank(upsell_page_folder($gate, (string) ($route['page_id'] ?? '')), $req->path);
        if ($best === null || $rank > $best[3]) {
            $best = [$i, $found[0], $found[1], $rank];
        }
    }
    if ($best === null) {
        return [$routes, null];
    }
    [$i, $funnel, $step] = $best;
    [$applied, $cookie] = upsell_apply($routes[$i], $funnel, $step, $req, $gate);
    if (empty($applied['slug_id']) || empty($applied['content_hash'])) {
        return [$routes, null];
    }
    unset($routes[$i]);
    return [[$applied, ...array_values($routes)], $cookie];
}

/**
 * The entry point before 20261014d, kept for a respond.php of that time while a
 * deploy swaps the files (OPcache revalidates each file every 2 s): the route
 * as it is. Nothing calls it now; it goes with the next deploy.
 *
 * @return array{0: array, 1: null}
 */
function upsell_route(array $route, ?array $gate, Request $req): array
{
    return [$route, null];
}

/**
 * The route an upsell step serves for this buyer, and the visitor cookie to set
 * (null = it already had one, or the step needs none).
 *
 * The route keeps the requested path as its slug ({{slug}}, the log) and, when a
 * version is picked, takes the upsell page's id, hash and type. It gains
 * `_upsell`: origin (the tracker's), hit (pages.hits.upsell), offer and
 * downsells (their checkout values, for the tracker's &o= / &ds=) and product
 * (the vendor page's product's core id, for &product_id=; null = none).
 *
 * @return array{0: array, 1: ?string}
 */
function upsell_apply(array $route, array $funnel, array $step, Request $req, ?array $gate = null): array
{
    $sid = (string) $step['id'];
    $hit = ['f' => (string) ($funnel['id'] ?? ''), 's' => $sid];
    $product = vendor_product_id($gate, (string) ($route['page_id'] ?? ''));
    if ($sid === 'ty') {
        $route['_upsell'] = ['origin' => UPSELL_ORIGINS['ty'], 'hit' => $hit, 'offer' => '', 'downsells' => [], 'product' => $product];
        return [$route, null];
    }
    $group = upsell_group($step, upsell_front($funnel, $req->rawQuery));
    if ($group === null) {
        $route['_upsell'] = ['origin' => UPSELL_ORIGINS[$sid], 'hit' => $hit, 'offer' => '', 'downsells' => [], 'product' => $product];
        return [$route, null];
    }
    [$visitor, $cookie] = upsell_visitor($req->cookies);
    $flow = upsell_flow($funnel, $req);
    $seed = $visitor . '|' . $hit['f'] . '|' . $sid . '|' . (string) ($group['id'] ?? '') . '|' . $flow;

    // The page version: an upsell page the gate carries (its served slug's hash came with it).
    $known = is_array($funnel['pages'] ?? null) ? $funnel['pages'] : [];
    $pages = is_array($group['pages'] ?? null) ? $group['pages'] : [];
    $versions = array_values(array_filter(
        (array) (is_array($pages[$flow] ?? null) && $pages[$flow] !== [] ? $pages[$flow] : ($pages['default'] ?? [])),
        static fn($v): bool => is_array($v) && is_array($known[(string) ($v['page_id'] ?? '')] ?? null) && !empty($known[(string) $v['page_id']]['hash']),
    ));
    $page = upsell_weighted($versions, $seed . '|page');
    if ($page !== null) {
        $p = $known[(string) $page['page_id']];
        $route['page_id'] = (string) $page['page_id'];
        $route['slug_id'] = md5((string) ($route['domain_id'] ?? '') . ':' . $route['page_id'] . ':' . (string) ($p['slug'] ?? '/'));
        $route['content_hash'] = (string) $p['hash'];
        $route['content_type'] = (string) ($p['type'] ?? 'text/html; charset=utf-8');
        unset($route['funnel']); // the steps flag was the vendor page's slug's: the served page is read
    }

    // The CTA (the offer) and the downsells: checkout keys, filled with the product's values on its platform.
    $placeholders = is_array($route['placeholders'] ?? null) ? $route['placeholders'] : [];
    $value = static fn(?string $key): string => $key !== null && $key !== '' ? (string) ($placeholders['checkout.' . $key] ?? '') : '';
    $offer = upsell_weighted((array) ($group['offers'] ?? []), $seed . '|offer');
    $offerKey = is_array($offer) ? (string) ($offer['offer'] ?? '') : '';
    $placeholders['upsell.offer'] = $value($offerKey);
    $dsKeys = [];
    $dsValues = [];
    foreach (array_values((array) ($group['downsells'] ?? [])) as $i => $slot) {
        $pick = is_array($slot) ? upsell_weighted($slot, $seed . '|ds' . $i) : null;
        $key = is_array($pick) ? (string) ($pick['offer'] ?? '') : '';
        $dsKeys[] = $key;
        $dsValues[] = $placeholders['upsell.downsell' . ($i + 1)] = $value($key);
    }
    $route['placeholders'] = $placeholders;

    // The group's VSL videos: the draw is vsl.php's ({{video_id}}, the A/B player).
    $vsls = array_values(array_filter((array) ($group['vsls'] ?? []), 'is_array'));
    if ($vsls !== []) {
        $route['vsl'] = $vsls;
    }

    // p = the upsell page served (its id), or the vendor page's own slug when no version was picked.
    $served = $page !== null ? (string) $page['page_id'] : (string) ($route['slug'] ?? '');
    $hit += ['g' => (string) ($group['id'] ?? ''), 'fl' => $flow, 'p' => $served, 'o' => $offerKey !== '' ? $offerKey : null, 'ds' => $dsKeys];
    $route['_upsell'] = ['origin' => UPSELL_ORIGINS[$sid], 'hit' => $hit, 'offer' => $placeholders['upsell.offer'], 'downsells' => $dsValues, 'product' => $product];
    return [$route, $cookie];
}

/** The tracker's extra parameters for an upsell step: the offer's and the downsells' codes (dot.js tells accept from downsell by them) and what was served. */
function upsell_track_params(?array $upsell): array
{
    if ($upsell === null) {
        return [];
    }
    $q = [];
    if (($upsell['offer'] ?? '') !== '') {
        $q['o'] = (string) $upsell['offer'];
    }
    $ds = array_values(array_filter(array_map('strval', (array) ($upsell['downsells'] ?? [])), static fn(string $v): bool => $v !== ''));
    if ($ds !== []) {
        $q['ds'] = implode(',', $ds);
    }
    // What this buyer got (group|flow|page version): the answers carry it to dot, per version.
    $hit = is_array($upsell['hit'] ?? null) ? $upsell['hit'] : [];
    if (isset($hit['g'], $hit['fl'], $hit['p'])) {
        $q['u'] = $hit['g'] . '|' . $hit['fl'] . '|' . $hit['p'];
    }
    return $q;
}

/** The ETag piece of an upsell response: what was picked (the served slug's hash and the offers' values are elsewhere). */
function upsell_etag(?array $upsell): string
{
    return $upsell === null ? '' : '-u' . substr(md5((string) json_encode($upsell['hit'] ?? [])), 0, 8);
}

/**
 * The {page_id, slug, hash} of every upsell page the gate's upsell funnels may
 * serve: content_get fetches the ones missing on disk, and the cleanup leaves
 * them alone.
 *
 * @return list<array{page_id: string, slug: string, hash: string}>
 */
function upsell_content_refs(array $gate): array
{
    $refs = [];
    foreach ((array) ($gate['upsell'] ?? []) as $funnel) {
        foreach ((array) (is_array($funnel) ? ($funnel['pages'] ?? []) : []) as $pageId => $p) {
            $hash = is_array($p) ? (string) ($p['hash'] ?? '') : '';
            if ($hash !== '' && count($refs) < UPSELL_MAX_REFS) {
                $refs[(string) $pageId] = ['page_id' => (string) $pageId, 'slug' => (string) ($p['slug'] ?? '/'), 'hash' => $hash];
            }
        }
    }
    return array_values($refs);
}

// ── The vendor page's own tracker: its landing, and the product on every vendor route ──

/** The tracker's origin on a vendor page's landing (its folder's root): a page_view at once, like the Lander. */
const VENDOR_FRONT_ORIGIN = 'vendor_front';

/**
 * The core product id of a vendor page's product (resolve's gate.vendor —
 * pages.products.core_product_id, 20261015b); null = none, or not a vendor page.
 */
function vendor_product_id(?array $gate, string $pageId): ?string
{
    $id = is_array($gate['vendor'][$pageId] ?? null) ? ($gate['vendor'][$pageId]['product'] ?? null) : null;
    return is_string($id) && preg_match('/^[a-z0-9][a-z0-9_-]{0,99}$/', $id) === 1 ? $id : null;
}

/**
 * The route the gate picked, marked for the vendor's tracker when it is a vendor
 * page's LANDING — the page's own slug at its folder's root ("/" at the root,
 * "/bg" in the /bg folder; never a legal page or another slug): `_vendor` =
 * {origin vendor_front, product}. An upsell step is already marked (`_upsell`);
 * any other route — every non-VENDOR page — comes back as it is.
 */
function vendor_route_mark(array $route, ?array $gate, Request $req): array
{
    $pageId = (string) ($route['page_id'] ?? '');
    if (isset($route['_upsell']) || ($route['action'] ?? '') !== 'SERVE' || empty($route['slug_id']) || !is_array($gate['vendor'][$pageId] ?? null)) {
        return $route;
    }
    $folder = upsell_page_folder($gate, $pageId);
    if (strtolower($req->path) !== ($folder !== '' ? strtolower($folder) : '/')) {
        return $route;
    }
    $route['_vendor'] = ['origin' => VENDOR_FRONT_ORIGIN, 'product' => vendor_product_id($gate, $pageId)];
    return $route;
}

/**
 * The tracker's product parameters on a vendor route (the landing or an upsell
 * step): &product_id= (the core product) and &step= (the origin) — dot.js puts
 * both in every event. None when the product has no core id.
 *
 * @return array<string, string>
 */
function vendor_track_params(?array $mark): array
{
    $product = is_array($mark) && is_string($mark['product'] ?? null) ? $mark['product'] : null;
    return $product === null ? [] : ['product_id' => $product, 'step' => (string) ($mark['origin'] ?? '')];
}

/** The ETag piece of a vendor route's tracker (its origin and product): '' on any other route. */
function vendor_etag(?array $mark): string
{
    return $mark === null ? '' : '-w' . substr(md5((string) ($mark['origin'] ?? '') . '|' . (string) ($mark['product'] ?? '')), 0, 8);
}
