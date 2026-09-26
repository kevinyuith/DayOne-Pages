<?php
/**
 * Load notice: tells "the page loaded in the browser" apart from pings,
 * curl, prefetch and link-preview bots, which also count as "served".
 *
 *   1. A funnel's page served by the gate (match_type GATE; HTML, 200/304)
 *      gets a visit id in the dop_v cookie (10 min) and, before </body>, a
 *      minimal script. The safe page (the domain's page, GATE-SAFE)
 *      and every other route go without either: nothing to measure there.
 *   2. On the load event, the script calls sendBeacon("/_dop/l", "t=<ms>"),
 *      with the time since navigation start, plus "sg=<json>": the device's
 *      capability signals (webdriver, platform, touch points, cores, memory,
 *      languages/plugins, screen/viewport, pointer/hover media, chrome,
 *      userAgentData, cookies). On the first real interaction (the mouse moved
 *      or pressed, a wheel scroll, a touch or a key; events the browser made,
 *      not a script) it sends "i=<kind>&t=<ms>". On the first click that
 *      leaves the page (a link or data-href that navigates; "#…" doesn't
 *      count), it sends "c=1". Every time the page is hidden or left
 *      (visibilitychange → hidden, pagehide) it sends "d=<ms>" (how long it
 *      has been open) with "sg=<json>": the session's trusted event counts
 *      (mouse, scroll, touch, key, click — 0 on a device that has the pointer
 *      means nobody drove it, a bot hint).
 *   3. /_dop/l answers 204 right away and, after the response, marks the
 *      visit's hit (pages.hits.loaded_at/load_ms — RPC log_load; interacted_at/
 *      interaction/interaction_ms — log_interact; clicked_at — log_click;
 *      duration_ms, the longest report — log_duration; signals — log_signals),
 *      retrying while the hit isn't written yet (beacon_record). The Logs
 *      screen shows it, and the Funnel screen sums loads and clicks per page
 *      (A/B test between the pages of a funnel). The signals are INFORMATIONAL
 *      ONLY: nothing is blocked or labeled from them.
 *
 * The id goes in the cookie, not in the HTML, so the script is always the
 * same: the body stays cacheable and a 304 (which has no body) still carries
 * the new id in Set-Cookie. The script reads it once, when the page loads,
 * and sends it with every notice ("v=<id>&…"): a later page of the same
 * domain (a reload, another tab) sets a new cookie, and the "left the page"
 * notice, sent after that, must still land on this page's hit. So the cookie
 * isn't HttpOnly — it's a random visit id, not a credential. The ETag gets
 * BEACON_ETAG so old copies of the script are not reused by the browser.
 *
 * It only measures. It doesn't change what the visitor sees.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const BEACON_PATH = '/_dop/l';
const BEACON_COOKIE = 'dop_v';
/** ETag suffix of pages with the script. Changed the script, bump the version. */
const BEACON_ETAG = '-b5';
/** The longest time on a page that is taken (4 hours). */
const BEACON_MAX_DURATION_MS = 14400000;
/** The kinds of the first interaction ("i=<kind>"), as pages.hits.interaction takes them. */
const BEACON_INTERACTIONS = ['mouse', 'scroll', 'touch', 'key'];
const BEACON_SCRIPT = '<script data-dop-beacon>(function(){var v=(document.cookie.match(/(?:^|; )' . BEACON_COOKIE . '=([0-9a-f]{32})/)||[])[1];'
    . 'function b(d){try{navigator.sendBeacon("' . BEACON_PATH . '",(v?"v="+v+"&":"")+d)}catch(e){}}'
    . 'function enc(o){return "sg="+encodeURIComponent(JSON.stringify(o))}'
    . 'var M=function(q){try{return matchMedia(q).matches}catch(e){return false}},N=navigator,U=N.userAgentData||{},S={'
    . 'wd:N.webdriver===true?1:0,pl:(""+(N.platform||"")).slice(0,32),mtp:N.maxTouchPoints|0,hc:N.hardwareConcurrency|0,dm:N.deviceMemory||0,'
    . 'nl:(N.languages||[]).length,np:(N.plugins||[]).length,sw:screen.width|0,sh:screen.height|0,dpr:+(window.devicePixelRatio||1).toFixed(2),'
    . 'vw:innerWidth|0,vh:innerHeight|0,ptr:M("(pointer:fine)")?"fine":M("(pointer:coarse)")?"coarse":"none",hvr:M("(hover:hover)")?1:0,'
    . 'chr:window.chrome?1:0,cke:N.cookieEnabled?1:0};'
    . 'if(U.mobile!==undefined)S.mob=U.mobile?1:0;if(U.platform)S.upf=(""+U.platform).slice(0,32);'
    . 'function s(){b("t="+Math.round(performance.now()));b(enc(S))}if(document.readyState==="complete")s();else addEventListener("load",s,{once:true});'
    . 'var K={mm:0,md:0,wh:0,sc:0,ts:0,ky:0,ck:0},c=false;addEventListener("click",function(e){if(e.isTrusted&&K.ck<999)K.ck++;if(c)return;var t=e.target,a=t&&t.closest&&t.closest("a[href],[data-href]");if(!a)return;'
    . 'var h=a.getAttribute("data-href")||a.getAttribute("href")||"";if(!h||h.charAt(0)==="#"||h.indexOf("javascript:")===0)return;c=true;b("c=1")},true);'
    . 'var i=false;function n(k,y){return function(e){if(e.isTrusted&&(e.type!=="mousemove"||e.movementX||e.movementY)&&K[y]<999)K[y]++;if(i||!e.isTrusted||(e.type==="mousemove"&&!e.movementX&&!e.movementY))return;i=true;b("i="+k+"&t="+Math.round(performance.now()))}}'
    . '[["mousemove","mouse","mm"],["mousedown","mouse","md"],["wheel","scroll","wh"],["touchstart","touch","ts"],["keydown","key","ky"]].forEach(function(p){addEventListener(p[0],n(p[1],p[2]),{capture:true,passive:true})});'
    . 'addEventListener("scroll",function(e){if(e.isTrusted&&K.sc<999)K.sc++},{capture:true,passive:true});'
    . 'function u(){b("d="+Math.round(performance.now())+"&"+enc(K))}addEventListener("pagehide",u);addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")u()})})();</script>';

/**
 * Does this route's response carry the notice? Only a funnel's page served by
 * the gate (match_type GATE — the split's pick keeps it) that is HTML (.html,
 * .php or no extension). The safe page and any other route: no script, no
 * visit cookie.
 */
function beacon_applies(array $route, Request $req): bool
{
    if (($route['match_type'] ?? '') !== GATE_MATCH) {
        return false;
    }
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
    return BEACON_COOKIE . "=$visitId; Path=/; Max-Age=600; Secure; SameSite=Lax";
}

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

/**
 * POST /_dop/l → 204 + [visit id, notice] to store after the response. The
 * visit id: the body's "v" (the script's page), else the cookie (an older
 * script). The notice's kind: "load" (t = ms to the load event), "click"
 * ("c=1": the visitor clicked out of the page), the first interaction
 * ("i=mouse|scroll|touch|key", t = ms to it) or "duration" ("d=<ms>": the page
 * was hidden or left after that long). Any of them may carry "sg=<json>": the
 * device signals (capabilities at load, the session's event counts when
 * hidden/left), sanitized here (an "sg" that doesn't parse is just dropped,
 * the notice itself still counts). Without a valid id, an unknown "i" or
 * a bad "d", 204 and nothing to store. Other method: 404.
 *
 * @return array{0: int, 1: array<string,string>, 2: ?string, 3: ?string, 4: array{kind: string, ms: ?int, sg?: array<string, bool|int|float|string>}}
 */
function handle_beacon(Request $req, string $body): array
{
    if ($req->method !== 'POST') {
        return [...not_found(), null, ['kind' => 'load', 'ms' => null]];
    }
    parse_str($body, $form);
    $visitId = is_string($form['v'] ?? null) && preg_match('/^[0-9a-f]{32}$/', $form['v']) === 1
        ? $form['v']
        : (string) ($req->cookies[BEACON_COOKIE] ?? '');
    if (preg_match('/^[0-9a-f]{32}$/', $visitId) !== 1) {
        $visitId = null;
    }
    $t = $form['t'] ?? null;
    $ms = is_string($t) && ctype_digit($t) && (int) $t <= 600000 ? (int) $t : null;
    $i = $form['i'] ?? null;
    $d = $form['d'] ?? null;
    if ($i !== null) {
        $kind = is_string($i) && in_array($i, BEACON_INTERACTIONS, true) ? $i : null;
        $visitId = $kind === null ? null : $visitId;
    } elseif ($d !== null) {
        $kind = 'duration';
        $ms = is_string($d) && ctype_digit($d) && strlen($d) <= 9 && (int) $d <= BEACON_MAX_DURATION_MS ? (int) $d : null;
        $visitId = $ms === null ? null : $visitId;
    } else {
        $kind = ($form['c'] ?? null) === '1' ? 'click' : 'load';
    }
    $notice = ['kind' => $kind ?? 'load', 'ms' => $kind === 'click' ? null : $ms];
    $sg = beacon_parse_signals($form['sg'] ?? null);
    if ($sg !== null) {
        $notice['sg'] = $sg;
    }
    return [204, ['Cache-Control' => 'no-store'], null, $visitId, $notice];
}

/**
 * The "sg" payload as the hit takes it: a flat JSON object with short keys
 * and scalar values, at most ~1.8 KB. Anything else (nested, huge, wrong)
 * is dropped — the signals are informational, never worth rejecting a notice.
 *
 * @return array<string, bool|int|float|string>|null
 */
function beacon_parse_signals(mixed $raw): ?array
{
    if (!is_string($raw) || strlen($raw) > 1800) {
        return null;
    }
    $dec = json_decode($raw, true);
    if (!is_array($dec) || $dec === [] || count($dec) > 48) {
        return null;
    }
    $clean = [];
    foreach ($dec as $k => $val) {
        if (!is_string($k) || preg_match('/^[a-z_]{1,12}$/', $k) !== 1) {
            continue;
        }
        if (is_bool($val) || is_int($val) || is_float($val)) {
            $clean[$k] = $val;
        } elseif (is_string($val) && strlen($val) <= 60) {
            $clean[$k] = $val;
        }
    }
    return $clean === [] ? null : $clean;
}

/** Sends a notice to its hit (beacon_record's $send): true = recorded, false = no hit yet, null = failed. */
function beacon_send(string $visitId, array $notice): ?bool
{
    $r = match ($notice['kind']) {
        'load' => supabase_log_load($visitId, $notice['ms']),
        'click' => supabase_log_click($visitId),
        'duration' => supabase_log_duration($visitId, (int) $notice['ms']),
        default => supabase_log_interact($visitId, $notice['kind'], $notice['ms']),
    };
    if ($r === false) {
        return false; // No hit yet: the whole notice is retried.
    }
    $sg = $notice['sg'] ?? null;
    if (is_array($sg) && $sg !== []) {
        $r2 = supabase_log_signals($visitId, $sg);
        if ($r2 === false) {
            return false; // No hit yet: retry (the notice's own RPC is idempotent).
        }
        if ($r2 === true) {
            $r = true;
        }
    }
    return $r;
}
