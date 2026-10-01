<?php
/**
 * The device checkpoint — the Suspicious stage of the gate, run in the browser.
 *
 * The gate (rules.php) decides with the request's data alone: headers, URL,
 * IP. What only a browser knows (a real touchscreen, the pointer kind, the
 * WebGL renderer, automation hooks…) only arrives later, with the beacon's
 * signals — when the funnel page already loaded. Too late to keep a bot OUT
 * of the funnel.
 *
 * The checkpoint closes that gap, in one GET + one POST to the SAME URL (the
 * Adspect pattern — no verdict parameter in the query, no extra round trip):
 *
 *   1. GET  /?sub1=[F23]&sub11=taboola   a clean click a Suspicious rule is
 *      still after (eval_checkpoint_applies) gets THIS page: a minimal,
 *      uncacheable HTML whose script collects the device's signals and
 *      submits a hidden form POST back to the same URL, with the signals as
 *      `dop_ev` (a JSON: {"sg":{…}, "v":{…the checkpoint's own fields…}}).
 *   2. POST same URL, same query          the request method stays POST, but
 *      the server reads the query from the URL and the eval payload from the
 *      body, walks the gate again with the signals now known, and answers
 *      the final response right there: the domain's SAFE page when a
 *      Suspicious rule matched (the SAME detection a request-stage match
 *      would log), the FUNNEL page when none did. The visitor never sees a
 *      redirect; the address bar never changes.
 *
 * A passed checkpoint sets the `dop_ev` cookie ("ok", 1 h): later clicks skip
 * the page. A browser without JS (a plain bot) never posts the form: it
 * stays on a blank page and never reaches the funnel — the checkpoint is a
 * challenge too. And a rule can name `eval_cookie: "absent"` to catch, right
 * in the gate's walk, a click that never passed.
 *
 * The page is never cached (no-store, no ETag, every response 200) and its
 * hit is logged as "SERVE · GATE · EVAL": never a funnel view, never a safe
 * page view. The POST's own hit is the final response's (safe or funnel),
 * marked with the rule when one matched. A prefetch skips the checkpoint
 * (safe page, " · EVAL-PREFETCH").
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** The POST field with the checkpoint's payload (JSON: {"sg":{signals}}). */
const EVAL_FIELD = 'dop_ev';
/** The checkpoint cookie: "ok" = passed (1 hour), a signals-entry key otherwise (1 day). */
const EVAL_COOKIE = 'dop_ev';
const EVAL_COOKIE_OK = 'ok';
const EVAL_SIGNALS_TTL = 86400;
const EVAL_OK_TTL = 3600;

/** no_js is special: a POST proves JS ran, so it's never evaluated from signals — the GET-side walk (eval_no_js_rule) decides it. */
const EVAL_NO_JS = 'no_js';
/** The eval rules' own condition keys (decided here or in the browser; never by conditions_match). */
const EVAL_OWN_CONDITIONS = [
    'eval_cookie', 'touch', 'mobile_hint', 'pointer', 'webdriver', 'automation', 'gl_software', 'platform',
    'iframe', 'tostring_tampered', 'proto_poisoned', 'tz_offset',
    // The on/off detectors (1 = the tell fired). no_js is stripped too, but
    // never evaluated from signals — a POST proves JS ran.
    'no_touch', 'chrome_ua', 'no_chrome_object', 'tz_mismatch', 'no_cookie', 'odd_resolution', EVAL_NO_JS,
];
/** The rule keys the checkpoint itself evaluates (never left to conditions_match). */
const EVAL_RULE_KEYS = ['sub1', 'sub11', 'param'];

/**
 * Should this click see the checkpoint page? Only when at least one eval
 * (Suspicious) rule can still match it — the request's own data (sub ids,
 * URL parameters, the base conditions, eval_cookie) and whatever signals
 * are already known (a previous checkpoint's stored ones). A click no
 * Suspicious rule is after (a sub11 none of them names, a device none of
 * them targets) goes straight to the funnel: no page, no round trip.
 */
function eval_checkpoint_applies(array $rules, Request $req): bool
{
    if (($req->cookies[EVAL_COOKIE] ?? '') === EVAL_COOKIE_OK) {
        return false;
    }
    $stored = eval_signals_for_cookie($req);
    foreach ($rules as $rule) {
        if (!is_array($rule)) {
            continue;
        }
        $cond = is_array($rule['conditions'] ?? null) ? $rule['conditions'] : [];
        if (eval_conditions_match($cond, $req, null, $stored, true)) {
            return true;
        }
    }
    return false;
}

/**
 * The GET side of "no JS": the checkpoint page was served but the visitor
 * never POSTed (no ok cookie, no signals entry) — the form never ran. Only a
 * rule that NAMES `no_js: 1` can confirm it; any other signal condition
 * stays undecidable on a GET. Returns the first such rule whose other
 * conditions the request matches, so the gate flags the click right away
 * instead of leaving it on the blank page.
 */
function eval_no_js_rule(array $rules, Request $req): ?array
{
    foreach ($rules as $rule) {
        if (!is_array($rule)) {
            continue;
        }
        $cond = is_array($rule['conditions'] ?? null) ? $rule['conditions'] : [];
        if (($cond[EVAL_NO_JS] ?? null) !== 1) {
            continue;
        }
        $rest = $cond;
        unset($rest[EVAL_NO_JS]);
        if (eval_conditions_match($rest, $req, null, eval_signals_for_cookie($req), true)) {
            return $rule;
        }
    }
    return null;
}

/**
 * The checkpoint page. Only ever a 200, never cached, never an ETag.
 *
 * The script (inline — no extra request) collects the beacon's capability
 * signals (keep both in sync) and submits a hidden form POST back to the
 * same URL with them as `dop_ev`. No fetch, no JSON endpoint: the POST's
 * response IS the final page (safe or funnel).
 */
function eval_checkpoint_response(): array
{
    // No <title> ("Loading" on a blank page is a cloaker fingerprint) and the
    // script in the <head>: the earlier it runs, the less time a bot has to
    // inspect the page before the POST is gone. The form submits without
    // being in the DOM (every modern browser), so there's no waiting for <body>.
    $html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        . '<meta http-equiv="X-UA-Compatible" content="IE=Edge">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<meta name="robots" content="noindex,nofollow">'
        . '<script>(function(){'
        // The capability signals — the same keys the beacon sends in "sg" (beacon.php).
        . 'var M=function(q){try{return matchMedia(q).matches}catch(e){return false}},N=navigator,U=N.userAgentData||{},S={'
        . 'wd:N.webdriver===true?1:0,pl:(""+(N.platform||"")).slice(0,32),mtp:N.maxTouchPoints|0,hc:N.hardwareConcurrency|0,dm:N.deviceMemory||0,'
        . 'nl:(N.languages||[]).length,np:(N.plugins||[]).length,sw:screen.width|0,sh:screen.height|0,dpr:+(window.devicePixelRatio||1).toFixed(2),'
        . 'vw:innerWidth|0,vh:innerHeight|0,ptr:M("(pointer:fine)")?"fine":M("(pointer:coarse)")?"coarse":"none",hvr:M("(hover:hover)")?1:0,'
        . 'chr:window.chrome?1:0,cke:N.cookieEnabled?1:0};'
        . 'if(U.mobile!==undefined)S.mob=U.mobile?1:0;if(U.platform)S.upf=(""+U.platform).slice(0,32);'
        // The Adspect-style tells: an iframe (self!==top — the page is never
        // framed legitimately on the gate), a monkey-patched toString (a bot
        // hides its hooks by overriding Function.prototype.toString; calling
        // it on a function that was NEVER overridden returns the native
        // source only when clean — the counter trick: a native toString is
        // called once by console.log and returns ""), a poisoned prototype
        // (a userscript/Tampermonkey replaced Array.prototype.includes: the
        // reference we saved is not the current one), and the time zone
        // (an emulator often has UTC while the IP says São Paulo).
        . 'try{S.ifr=(self!==top)?1:0}catch(e){S.ifr=1}'
        . 'try{var _f=function(){},_n=0;_f.toString=function(){_n++;return""};if(window.console&&console.log)console.log(_f);S.tst=(_n>0)?1:0}catch(e){}'
        . 'try{var _ai=Array.prototype.includes;S.ppo=(Array.prototype.includes!==_ai||(""+_ai).indexOf("[native code]")<0)?1:0}catch(e){}'
        . 'try{S.tz=(new Date).getTimezoneOffset()|0}catch(e){}'
        // The time zone's name ("America/Sao_Paulo"): the offset alone can't
        // tell São Paulo from Greenland; the name can (Intl, every modern browser).
        . 'try{var _tz=(Intl.DateTimeFormat().resolvedOptions().timeZone||"");if(_tz)S.tze=(""+_tz).slice(0,40)}catch(e){}'
        // Automation tells and the WebGL renderer run right away: this page
        // has nothing to paint, nothing to delay.
        . 'try{var _w=window,_a=0;if(_w.__playwright||_w.__puppeteer||_w.__pw_manual||_w._phantom||_w.callPhantom||_w.__nightmare||_w.domAutomation||_w.domAutomationController||_w.Cypress)_a++;if(document.$cdc_asdjflasutopfhvcZLmcfl_||document.__webdriver_evaluate||document.__selenium_unwrapped||document.__fxdriver_evaluate||document.__driver_evaluate)_a++;for(var _k in _w){if(_k.indexOf("cdc_")===0||_k.indexOf("$cdc_")===0){_a++;break}}S.aut=_a}catch(e){}'
        . 'try{var _cv=document.createElement("canvas"),_g=_cv.getContext("webgl")||_cv.getContext("experimental-webgl");if(_g){var _di=_g.getExtension("WEBGL_debug_renderer_info"),_r=""+(_di?_g.getParameter(_di.UNMASKED_RENDERER_WEBGL):_g.getParameter(_g.RENDERER));S.gl=_r.slice(0,60);S.glsw=/swiftshader|llvmpipe|softpipe|software|basic render|mesa|angle \\(google/i.test(_r)?1:0}else S.glsw=1}catch(e){}'
        // The payload and the form POST back to the same URL — submitted
        // without being in the DOM: no waiting for the body, nothing to see.
        . 'var f=document.createElement("form"),i=document.createElement("input");'
        . 'f.method="POST";f.action=location.pathname+location.search;i.type="hidden";i.name=' . json_encode(EVAL_FIELD) . ';'
        . 'i.value=JSON.stringify({sg:S});f.appendChild(i);document.documentElement.appendChild(f);f.submit()})();</script>'
        . '</head><body></body></html>';
    return [200, [
        'Content-Type' => 'text/html; charset=utf-8',
        'Cache-Control' => 'no-store',
        'X-Robots-Tag' => 'noindex, nofollow',
    ], $html];
}

/**
 * The eval payload from the checkpoint's POST body, when there is one:
 * `dop_ev` = {"sg":{…signals…}}. The request's evalParams come from the
 * QUERY (the form posts back to the same URL, so the sub ids are there).
 * Returns [the Request with evalParams filled, the signals] or null when
 * the body carries no checkpoint payload (a normal POST: the gate never
 * sees it here).
 *
 * @return array{0: Request, 1: array<string, bool|int|float|string>}|null
 */
function eval_post_payload(Request $req, string $body): ?array
{
    parse_str($body, $form);
    $raw = $form[EVAL_FIELD] ?? null;
    if (!is_string($raw) || strlen($raw) > 4096) {
        return null;
    }
    $dec = json_decode($raw, true);
    if (!is_array($dec)) {
        return null;
    }
    $signals = beacon_parse_signals(is_string($dec['sg'] ?? null) ? $dec['sg'] : json_encode($dec['sg'] ?? []));
    $clone = eval_request_from_query($req);
    return [$clone, is_array($signals) ? $signals : []];
}

/**
 * The eval rules whose conditions ALL match, in walk order, with the
 * signals now known (the POST's payload, or a previous checkpoint's stored
 * entry). Everything else (sub ids, URL parameters, eval_cookie) is decided
 * from the request. An undecidable signal never confirms a bot.
 *
 * @return list<array> the matching eval rules (gate-shaped), in walk order
 */
function eval_rules_matched(array $rules, Request $req, ?array $signals, ?array $stored): array
{
    $out = [];
    foreach ($rules as $rule) {
        if (!is_array($rule)) {
            continue;
        }
        $cond = is_array($rule['conditions'] ?? null) ? $rule['conditions'] : [];
        if (eval_conditions_match($cond, $req, $signals, $stored)) {
            $out[] = $rule;
        }
    }
    return $out;
}

/**
 * An eval rule's conditions against the request. The eval keys are stripped
 * before the base evaluators run (they'd reject them as unknown):
 *
 *   eval_cookie   "absent" = this visitor never passed the checkpoint
 *   touch         1 = a touchscreen (maxTouchPoints > 0), 0 = none
 *   mobile_hint   1/0 = userAgentData.mobile (Chrome/Android)
 *   pointer       "coarse" | "fine" | "none" (the primary pointer)
 *   webdriver     1 = navigator.webdriver
 *   automation    1 = automation artifacts (Playwright/Puppeteer/Selenium…)
 *   gl_software   1 = software WebGL (SwiftShader/llvmpipe/Mesa/no GL)
 *   platform      text contained in the device platform (case-insensitive)
 *   iframe        1 = the page ran inside a frame (self !== top)
 *   tostring_tampered 1 = Function.toString was monkey-patched (a bot hiding its hooks)
 *   proto_poisoned    1 = a built-in prototype was replaced (a userscript/emulator)
 *   tz_offset     the browser's getTimezoneOffset() (minutes; an emulator's often mismatches the IP's)
 *
 * With $allowPending, a signal condition whose value isn't known does NOT
 * fail the rule — it's "pending" (the checkpoint's applies-check). Without
 * it, unknown = no match: an undecidable signal never confirms a bot.
 */
function eval_conditions_match(array $cond, Request $req, ?array $signals, ?array $stored, bool $allowPending = false): bool
{
    $base = $cond;
    foreach (array_merge(EVAL_OWN_CONDITIONS, EVAL_RULE_KEYS) as $k) {
        unset($base[$k]);
    }
    if (!conditions_match($base, $req)) {
        return false;
    }
    // The sub ids (exact, case-insensitive) and the generic URL parameter —
    // from the request's query (evalParams), the same contract as
    // rule_conditions_match.
    foreach (['sub1', 'sub11'] as $key) {
        if (!isset($cond[$key])) {
            continue;
        }
        $v = $req->evalParams[$key] ?? null;
        if (!is_string($v) || strcasecmp($v, (string) $cond[$key]) !== 0) {
            return false;
        }
    }
    if (isset($cond['param']) && is_array($cond['param'])) {
        $p = $cond['param'];
        $name = (string) ($p['name'] ?? '');
        $v = ($name !== '' && isset($req->evalParams[$name]) && is_string($req->evalParams[$name])) ? $req->evalParams[$name] : null;
        if (array_key_exists('equals', $p)) {
            if ($v === null || strcasecmp($v, (string) $p['equals']) !== 0) return false;
        } elseif (array_key_exists('not_equals', $p)) {
            if ($v === null || strcasecmp($v, (string) $p['not_equals']) === 0) return false;
        } elseif (array_key_exists('absent_or_equals', $p)) {
            if ($v !== null && strcasecmp($v, (string) $p['absent_or_equals']) !== 0) return false;
        } elseif (array_key_exists('contains', $p)) {
            if ($v === null || stripos($v, (string) $p['contains']) === false) return false;
        } elseif (array_key_exists('present', $p)) {
            if ($v === null) return false;
        } else {
            return false;
        }
    }

    // "absent" = never passed and no stored signals: no cookie, or only the
    // provisional one (a reload before the POST landed).
    if (($cond['eval_cookie'] ?? null) === 'absent') {
        $cv = (string) ($req->cookies[EVAL_COOKIE] ?? '');
        if ($cv !== '') {
            return false;
        }
    }

    $sig = eval_signal_values($signals, $stored);
    $jsRan = is_array($signals) && $signals !== [];
    foreach (EVAL_OWN_CONDITIONS as $key) {
        if ($key === 'eval_cookie' || !array_key_exists($key, $cond)) {
            continue;
        }
        $want = $cond[$key];
        // The request-derived and GET-side conditions don't come from $sig.
        if ($key === EVAL_NO_JS) {
            // A POST proves JS ran (fires only when the rule wants 0); a GET
            // leaves it to eval_no_js_rule — pending there, undecidable here.
            $ok = $jsRan ? ((int) $want !== 1) : $allowPending;
        } elseif ($key === 'chrome_ua') {
            $ok = ((int) $want === 1) === eval_is_chrome_ua($req->userAgent);
        } elseif ($key === 'tz_mismatch') {
            $ok = ((int) $want === 1) === eval_tz_mismatch($sig, $req->country);
        } else {
            if (!array_key_exists($key, $sig)) {
                if ($allowPending) {
                    continue; // Not decidable yet: the rule stays in the running.
                }
                return false; // Undecidable never confirms a bot.
            }
            $got = $sig[$key];
            $ok = match ($key) {
                'pointer' => is_string($want) && strcasecmp((string) $got, $want) === 0,
                'platform' => is_string($want) && $want !== '' && stripos((string) $got, $want) !== false,
                'tz_offset' => (int) $got === (int) $want,
                default => ((int) $got === 1) === ((int) $want === 1),
            };
        }
        if (!$ok) {
            return false;
        }
    }
    return true;
}

/** A Chrome-family User-Agent: Chrome, Chromium, Edge or Opera (their token + a version). */
function eval_is_chrome_ua(string $ua): bool
{
    return preg_match('~(?:Chrome|Chromium|Edg|OPR|Brave)/\d~i', $ua) === 1;
}

/**
 * The browser's time zone against the request's country (CF-IPCountry). A
 * mismatch is a bot tell: an emulator in UTC behind a Brazilian IP. Only the
 * countries below are checked — the rest are inconclusive (no mismatch).
 * The zone NAME wins (America/Sao_Paulo vs America/Noronha); without it, the
 * offset (Brazil spans UTC-2…-5, so only 120–300 is plausible).
 */
function eval_tz_mismatch(array $sig, string $country): bool
{
    $cc = strtoupper($country);
    if ($cc === 'BR') {
        // $sig['tze'] is the zone name, lowercased (eval_signal_values).
        if (isset($sig['tze']) && is_string($sig['tze']) && $sig['tze'] !== '') {
            static $br = ['america/sao_paulo', 'america/noronha', 'america/belem', 'america/fortaleza', 'america/recife', 'america/bahia', 'america/maceio', 'america/araguaina', 'america/cuiaba', 'america/campo_grande', 'america/manaus', 'america/boa_vista', 'america/porto_velho', 'america/rio_branco', 'america/santarem'];
            return !in_array($sig['tze'], $br, true);
        }
        if (isset($sig['tz_offset'])) {
            $off = (int) $sig['tz_offset'];
            return $off < 120 || $off > 300;
        }
    }
    return false;
}

/**
 * The signal values to evaluate: the POST's fresh signals first, or a
 * previous checkpoint's stored entry. Mapped from the beacon's "sg" keys to
 * the condition keys (the same mapping the checkpoint's form script does).
 */
function eval_signal_values(?array $signals, ?array $stored): array
{
    $src = (is_array($signals) && $signals !== []) ? $signals : (is_array($stored) ? $stored : null);
    if (!is_array($src)) {
        return [];
    }
    $out = [];
    if (array_key_exists('mtp', $src)) $out['touch'] = ((int) $src['mtp'] > 0) ? 1 : 0;
    if (array_key_exists('mob', $src)) $out['mobile_hint'] = ((int) $src['mob'] === 1) ? 1 : 0;
    if (isset($src['ptr']) && is_string($src['ptr']) && $src['ptr'] !== '') $out['pointer'] = $src['ptr'];
    if (array_key_exists('wd', $src)) $out['webdriver'] = ((int) $src['wd'] === 1) ? 1 : 0;
    if (array_key_exists('aut', $src)) $out['automation'] = ((int) $src['aut'] > 0) ? 1 : 0;
    if (array_key_exists('glsw', $src)) $out['gl_software'] = ((int) $src['glsw'] === 1) ? 1 : 0;
    $pl = (string) ($src['upf'] ?? $src['pl'] ?? '');
    if ($pl !== '') $out['platform'] = strtolower($pl);
    if (array_key_exists('ifr', $src)) $out['iframe'] = ((int) $src['ifr'] === 1) ? 1 : 0;
    if (array_key_exists('tst', $src)) $out['tostring_tampered'] = ((int) $src['tst'] === 1) ? 1 : 0;
    if (array_key_exists('ppo', $src)) $out['proto_poisoned'] = ((int) $src['ppo'] === 1) ? 1 : 0;
    if (array_key_exists('tz', $src)) $out['tz_offset'] = (int) $src['tz'];
    if (isset($src['tze']) && is_string($src['tze']) && $src['tze'] !== '') $out['tze'] = strtolower($src['tze']);
    // The on/off detectors, derived from the raw signals.
    if (array_key_exists('mtp', $src)) $out['no_touch'] = ((int) $src['mtp'] <= 0) ? 1 : 0;
    if (array_key_exists('chr', $src)) $out['no_chrome_object'] = ((int) $src['chr'] === 1) ? 0 : 1;
    if (array_key_exists('cke', $src)) $out['no_cookie'] = ((int) $src['cke'] === 1) ? 0 : 1;
    if (isset($src['sw'], $src['vw']) && (int) $src['sw'] > 0 && (int) $src['vw'] > 0) {
        $out['odd_resolution'] = ((int) $src['vw'] > (int) $src['sw'] || (int) $src['vh'] > (int) $src['sh']) ? 1 : 0;
    }
    return $out;
}

/** The request with its query's parameters as evalParams (the form posts back to the same URL). */
function eval_request_from_query(Request $req): Request
{
    $params = [];
    parse_str($req->rawQuery, $params);
    $clean = [];
    foreach ($params as $k => $v) {
        if (is_string($k) && is_scalar($v)) {
            $clean[$k] = (string) $v;
        }
    }
    $clone = clone $req;
    $clone->evalParams = $clean;
    return $clone;
}

/** The signals cache key for this visitor: IP + User-Agent. */
function eval_signals_key(string $ip, string $ua): string
{
    return hash('sha256', $ip . '|' . $ua);
}

/** A previous checkpoint's stored signals, when the cookie names this visitor's live entry. */
function eval_signals_for_cookie(Request $req): ?array
{
    $key = (string) ($req->cookies[EVAL_COOKIE] ?? '');
    if ($key === '' || $key === EVAL_COOKIE_OK || preg_match('/^[0-9a-f]{16}$/', $key) !== 1) {
        return null;
    }
    $want = substr(eval_signals_key($req->ip, $req->userAgent), 0, 16);
    if (!hash_equals($want, $key)) {
        return null;
    }
    return eval_signals_get($key);
}

/** Stores the checkpoint's signals (1 day); returns the cookie value (the entry's key). */
function eval_signals_put(string $ip, string $ua, array $signals): string
{
    $key = substr(eval_signals_key($ip, $ua), 0, 16);
    $payload = json_encode(['stored_at' => time(), 'signals' => $signals]);
    if ($payload !== false) {
        @atomic_write(eval_signals_file($key), cache_wrap($payload));
    }
    return $key;
}

/** Reads a signals cache entry; null when missing or expired. */
function eval_signals_get(string $key): ?array
{
    $raw = @file_get_contents(eval_signals_file($key));
    if ($raw === false) {
        return null;
    }
    $dec = json_decode(cache_unwrap($raw) ?? '', true);
    if (!is_array($dec) || !isset($dec['stored_at']) || time() - (int) $dec['stored_at'] > EVAL_SIGNALS_TTL) {
        return null;
    }
    return is_array($dec['signals'] ?? null) ? $dec['signals'] : null;
}

function eval_signals_file(string $key): string
{
    return cache_dir() . '/eval/' . substr($key, 0, 2) . '/' . $key . '.php';
}

/** The checkpoint cookie: "ok" after a pass, or the signals entry's key. */
function eval_cookie(string $value): string
{
    $ttl = $value === EVAL_COOKIE_OK ? EVAL_OK_TTL : EVAL_SIGNALS_TTL;
    return EVAL_COOKIE . "=$value; Path=/; Max-Age=$ttl; Secure; SameSite=Lax";
}
