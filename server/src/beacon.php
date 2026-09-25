<?php
/**
 * Load notice: tells "the page loaded in the browser" apart from pings,
 * curl, prefetch and link-preview bots, which also count as "served".
 *
 *   1. A served HTML page (200/304) gets a visit id in the dop_v cookie
 *      (HttpOnly, 10 min) and, before </body>, a minimal script.
 *   2. On the load event, the script calls sendBeacon("/_dop/l", "t=<ms>"),
 *      with the time since navigation start. On the first click that leaves
 *      the page (a link or data-href that navigates; "#…" doesn't count), it
 *      sends "c=1".
 *   3. /_dop/l answers 204 right away and, after the response, marks the
 *      visit's hit (pages.hits.loaded_at/load_ms, clicked_at — RPC log_load;
 *      the click, log_click), retrying while the hit isn't written yet
 *      (beacon_record). The Logs screen shows it, and the Funnel screen sums
 *      loads and clicks per page (A/B test between the pages of a funnel).
 *
 * The id goes in the cookie, not in the HTML, so the script is always the
 * same: the body stays cacheable and a 304 (which has no body) still carries
 * the new id in Set-Cookie. The ETag gets BEACON_ETAG so old copies, without
 * the script, are not reused by the browser.
 *
 * It only measures. It doesn't change what the visitor sees.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const BEACON_PATH = '/_dop/l';
const BEACON_COOKIE = 'dop_v';
/** ETag suffix of pages with the script. Changed the script, bump the version. */
const BEACON_ETAG = '-b2';
const BEACON_SCRIPT = '<script data-dop-beacon>(function(){function b(d){try{navigator.sendBeacon("' . BEACON_PATH . '",d)}catch(e){}}'
    . 'function s(){b("t="+Math.round(performance.now()))}if(document.readyState==="complete")s();else addEventListener("load",s,{once:true});'
    . 'var c=false;addEventListener("click",function(e){if(c)return;var t=e.target,a=t&&t.closest&&t.closest("a[href],[data-href]");if(!a)return;'
    . 'var h=a.getAttribute("data-href")||a.getAttribute("href")||"";if(!h||h.charAt(0)==="#"||h.indexOf("javascript:")===0)return;c=true;b("c=1")},true)})();</script>';

/** Does this route's response carry the notice? Only HTML pages (.html, .php or no extension). */
function beacon_applies(array $route, Request $req): bool
{
    $type = (string) ($route['content_type'] ?? '') ?: 'text/html';
    return str_starts_with(strtolower($type), 'text/html') && is_logged_path($req->path);
}

/** The script before the last </body>; without </body>, at the end. */
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
 * POST /_dop/l → 204 + [visit id, ms, clicked?] to store after the response
 * ("c=1" = the visitor clicked out of the page). Without a valid cookie, 204
 * and nothing to store. Other method: 404.
 *
 * @return array{0: int, 1: array<string,string>, 2: ?string, 3: ?string, 4: ?int, 5: bool}
 */
/**
 * Records a notice on its hit, after the response. The hit is written after
 * the response too and may not be there yet: a notice that found no hit is
 * sent again after 1, 2 and 4 s (nobody waits — the connection is closed).
 * `$send` returns true (recorded), false (no hit yet) or null (the call
 * failed: not retried). Returns whether it was recorded.
 */
function beacon_record(callable $send, ?callable $sleep = null): bool
{
    $sleep ??= static fn (int $seconds) => sleep($seconds);
    foreach ([0, 1, 2, 4] as $wait) {
        if ($wait > 0) {
            $sleep($wait);
        }
        $r = $send();
        if ($r !== false) {
            return $r === true;
        }
    }
    return false;
}

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
