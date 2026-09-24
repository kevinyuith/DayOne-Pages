<?php
/**
 * From candidate routes to a response.
 *
 * Routes arrive in priority order, with the FALLBACK (the domain's default
 * page) last. The first whose `conditions` match decides:
 *
 *   SERVE     null slug_id → 404 (the route exists but the slug doesn't; it
 *             doesn't skip to the next one, so the error shows up instead of
 *             vanishing).
 *             If-None-Match equal to the hash → 304. Otherwise 200 with the HTML.
 *             Slug with a server-mode funnel (funnel.php): only the current step
 *             goes out, the ETag gets the step id and the response varies by Cookie.
 *             An HTML page gets the load notice (beacon.php).
 *             {{key}} placeholders become the domain's data (placeholders.php).
 *   REDIRECT  Location = redirect_url (+ original query if preserve_query).
 *   BLOCK     the configured status, with a minimal page.
 *
 * A route with a `bot` condition outside BLOCK is ignored: bot detection is
 * for barring, never for swapping the content.
 *
 * None matched: robots.txt has a default response; the rest is 404.
 * No routes at all (paused or unknown domain): 404 for everything, even
 * robots.txt — a domain that is offline answers nothing.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const PRIVATE_NO_CACHE = 'private, no-cache';

/**
 * Returns [status, headers, body, outcome, route]. `outcome` classifies the
 * hit for the traffic log: served | redirect | blocked | bot | notfound |
 * error. `route` is the one that decided (null if none matched), also for the log.
 *
 * @return array{0: int, 1: array<string,string>, 2: ?string, 3: string, 4: ?array}
 */
function decide(array $routes, Request $req): array
{
    foreach ($routes as $route) {
        $cond = is_array($route['conditions'] ?? null) ? $route['conditions'] : [];
        $action = (string) ($route['action'] ?? '');

        if (array_key_exists('bot', $cond) && $action !== 'BLOCK') {
            error_log('[dayone-pages] route with bot condition outside BLOCK ignored: ' . ($route['route_id'] ?? '?'));
            continue;
        }
        if (!conditions_match($cond, $req)) {
            continue;
        }

        switch ($action) {
            case 'SERVE':
                // A/B test between the pages of a funnel: the route becomes the drawn page.
                [$route, $splitCookie] = split_pick($route, $req->cookies);
                $r = serve_slug($route, $req);
                if (isset($route['split_count'])) {
                    if (!str_contains((string) ($r[1]['Vary'] ?? ''), 'Cookie')) {
                        $r[1]['Vary'] = trim(($r[1]['Vary'] ?? '') . ', Cookie', ', ');
                    }
                    if ($splitCookie !== null) {
                        $r[1]['Set-Cookie'] = [...(array) ($r[1]['Set-Cookie'] ?? []), split_cookie($splitCookie)];
                    }
                }
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

    if ($routes !== [] && $req->path === '/robots.txt') {
        return [...robots_default(), 'served', null];
    }
    return [...not_found(), 'notfound', null];
}

/** Maps a SERVE route's status to a traffic outcome. */
function serve_outcome(int $status): string
{
    return match ($status) {
        404 => 'notfound',
        503 => 'error',
        default => 'served', // 200 and 304
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
        // The route matched but the slug doesn't exist. robots.txt gets the default; the rest is 404.
        return $req->path === '/robots.txt' ? robots_default() : not_found();
    }

    $headers = [
        'Content-Type' => (string) ($route['content_type'] ?: 'text/html; charset=utf-8'),
        'Cache-Control' => PRIVATE_NO_CACHE,
        'Vary' => 'CF-IPCountry, User-Agent, Accept-Language',
    ];

    // An HTML page carries the load notice (beacon.php) and the ETag gets the
    // script version.
    $beacon = beacon_applies($route, $req);
    $tag = $beacon ? BEACON_ETAG : '';

    // {{key}} placeholders: the hash of the values goes into the ETag (placeholders.php).
    $values = placeholder_values($route, $req);
    $ptag = placeholders_etag($values);

    // A slug the cache already flagged as "not a server-mode funnel": the ETag
    // is just the hash and the 304 goes out without reading the content from
    // disk. Old cache (without the flag) or funnel: reads the content, because
    // the step goes into the ETag.
    if (($route['funnel'] ?? null) === false) {
        $headers['ETag'] = '"' . $hash . $ptag . $tag . '"';
        if ($req->ifNoneMatch !== null && etag_matches($req->ifNoneMatch, $headers['ETag'])) {
            return [304, $headers, null];
        }
    }

    $body = cache_read_content($hash);
    if ($body === null) {
        error_log("[dayone-pages] content missing from cache for slug $slugId ($hash)");
        return [503, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store', 'Retry-After' => '10'], plain_page('One moment', 'Updating the page. Please try again in a few seconds.')];
    }

    // A/B test: each step with several samples keeps the one drawn for this
    // visitor (dop_ab cookie); the combination goes into the ETag.
    $ab = ab_apply($body, $req->cookies);
    $abTag = '';
    if ($ab) {
        $body = $ab['html'];
        $abTag = $ab['tag'] !== '' ? '-' . $ab['tag'] : '';
        if ($ab['cookie'] !== null) {
            $headers['Set-Cookie'] = [ab_cookie($ab['cookie'])];
        }
    }

    // Server-mode funnel: the step goes into the ETag (each step is a different
    // body at the SAME URL). With an A/B test or a funnel, the response varies by Cookie.
    $funnel = funnel_apply($body, $req->cookies);
    $etag = '"' . $hash . $abTag . ($funnel ? '-' . $funnel['step'] : '') . $ptag . $tag . '"';
    if ($funnel) {
        $body = $funnel['html'];
    }
    if ($funnel || $abTag !== '') {
        $headers['Vary'] .= ', Cookie';
    }
    $headers['ETag'] = $etag;

    if ($req->ifNoneMatch !== null && etag_matches($req->ifNoneMatch, $etag)) {
        return [304, $headers, null];
    }

    $body = placeholders_apply($body, $values, $headers['Content-Type']);
    return [200, $headers, $beacon ? beacon_inject($body) : $body];
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
    if ($status === 404) {
        // A block with 404 is identical to a real 404: the visitor doesn't know they were barred.
        return not_found();
    }
    $title = match ($status) {
        403 => 'Access denied',
        410 => 'Page removed',
        451 => 'Unavailable',
    };
    return [$status, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => PRIVATE_NO_CACHE], plain_page($title, '')];
}

function not_found(): array
{
    return [404, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => PRIVATE_NO_CACHE], not_found_page()];
}

function service_unavailable(): array
{
    return [503, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store', 'Retry-After' => '30'], plain_page('One moment', 'The site is loading. Please try again in a few seconds.')];
}
