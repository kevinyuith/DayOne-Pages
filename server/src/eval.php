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
    'iframe', 'tostring_tampered', 'proto_poisoned', 'tz_offset', 'net_rtt_min',
    // The on/off detectors (1 = the tell fired). no_js is stripped too, but
    // never evaluated from signals — a POST proves JS ran.
    'no_touch', 'chrome_ua', 'no_chrome_object', 'tz_mismatch', 'tz_not_us', 'no_cookie', 'odd_resolution', EVAL_NO_JS,
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
    // The script is the frozen EVAL_SCRIPT blob: nothing is built per response.
    $html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        . '<meta http-equiv="X-UA-Compatible" content="IE=Edge">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<meta name="robots" content="noindex,nofollow">'
        . '<script>' . EVAL_SCRIPT . '</script>'
        . '</head><body></body></html>';
    return [200, [
        'Content-Type' => 'text/html; charset=utf-8',
        'Cache-Control' => 'no-store',
        'X-Robots-Tag' => 'noindex, nofollow',
    ], $html];
}

/** XOR-encodes a string with the build key and base64s it (the JS decoder undoes it). */
function eval_obf(string $s, int $key): string
{
    $x = '';
    for ($i = 0, $n = strlen($s); $i < $n; $i++) {
        $x .= chr(ord($s[$i]) ^ $key);
    }
    return base64_encode($x);
}

/**
 * The checkpoint's script, OBFUSCATED — a fixed, unreadable blob, built once
 * and served as-is (zero work per response). Every string (property names,
 * hooks, the regex, the form field's name — `dop_ev` plus a suffix) is
 * XOR+base64 and decoded in runtime by an opaque decoder; every global is
 * reached through `window[…]` with the name encoded, so no `navigator`,
 * `webdriver`, `maxTouchPoints`, `form` or `dop_ev` ever appears in the
 * clear. `atob` is spelled out as char codes. Only the control flow and a
 * few opaque one-letter locals stay readable — nothing that says what the
 * page measures or where the POST goes.
 *
 * Frozen from eval_checkpoint_build by `php server/dev/regen-eval-script.php`
 * — run it again (and review the diff) whenever the signals change. The test
 * asserts this constant matches the build, so a drift is caught.
 */
/** The fixed seed the frozen EVAL_SCRIPT was built with (eval_checkpoint_build's defaults). */
const EVAL_BUILD_KEY = 46;
const EVAL_BUILD_IDENT = 'mlsZWGP';
const EVAL_BUILD_FIELD_SUFFIX = 'a1b2c3';

const EVAL_SCRIPT =
    '(function(){var k=46;function mlsZWGP(s,x){var b=window[String.fromCharCode(97,116,111,98)](s),o=\'\',i;for(i=0;i<b.length;i++)o+=String.fromCharCode(b.charCodeAt(i)^x);return o}
var W=window,D=W[mlsZWGP(\'SkFNW0NLQFo=\',k)],M=function(q){try{return W[mlsZWGP(\'Q09aTUZjS0pHTw==\',k)](q)[mlsZWGP(\'Q09aTUZLXQ==\',k)]}catch(e){return false}},N=W[mlsZWGP(\'QE9YR0lPWkFc\',k)],U=N[mlsZWGP(\'W11LXG9JS0Baak9aTw==\',k)]||{},S={},A=function(n,v){S[n]=v};
A(mlsZWGP(\'WUo=\',k),N[mlsZWGP(\'WUtMSlxHWEtc\',k)]===true?1:0);
A(mlsZWGP(\'XkI=\',k),(mlsZWGP(\'\',k)+(N[mlsZWGP(\'XkJPWkhBXEM=\',k)]||mlsZWGP(\'\',k)))[mlsZWGP(\'XUJHTUs=\',k)](0,32));
A(mlsZWGP(\'Q1pe\',k),N[mlsZWGP(\'Q09WekFbTUZ+QUdAWl0=\',k)]|0);
A(mlsZWGP(\'Rk0=\',k),N[mlsZWGP(\'Rk9cSllPXEttQUBNW1xcS0BNVw==\',k)]|0);
A(mlsZWGP(\'SkM=\',k),N[mlsZWGP(\'SktYR01LY0tDQVxX\',k)]||0);
A(mlsZWGP(\'QEI=\',k),(N[mlsZWGP(\'Qk9ASVtPSUtd\',k)]||[])[mlsZWGP(\'QktASVpG\',k)]);
A(mlsZWGP(\'QF4=\',k),(N[mlsZWGP(\'XkJbSUdAXQ==\',k)]||[])[mlsZWGP(\'QktASVpG\',k)]);
A(mlsZWGP(\'XVk=\',k),W[mlsZWGP(\'XU1cS0tA\',k)][mlsZWGP(\'WUdKWkY=\',k)]|0);
A(mlsZWGP(\'XUY=\',k),W[mlsZWGP(\'XU1cS0tA\',k)][mlsZWGP(\'RktHSUZa\',k)]|0);
A(mlsZWGP(\'Sl5c\',k),+(W[mlsZWGP(\'SktYR01LfkdWS0J8T1pHQQ==\',k)]||1)[mlsZWGP(\'WkFoR1ZLSg==\',k)](2));
A(mlsZWGP(\'WFk=\',k),W[mlsZWGP(\'R0BAS1x5R0paRg==\',k)]|0);
A(mlsZWGP(\'WEY=\',k),W[mlsZWGP(\'R0BAS1xmS0dJRlo=\',k)]|0);
A(mlsZWGP(\'Xlpc\',k),M(mlsZWGP(\'Bl5BR0BaS1wUSEdASwc=\',k))?mlsZWGP(\'SEdASw==\',k):M(mlsZWGP(\'Bl5BR0BaS1wUTUFPXF1LBw==\',k))?mlsZWGP(\'TUFPXF1L\',k):mlsZWGP(\'QEFASw==\',k));
A(mlsZWGP(\'Rlhc\',k),M(mlsZWGP(\'BkZBWEtcFEZBWEtcBw==\',k))?1:0);
A(mlsZWGP(\'TUZc\',k),W[mlsZWGP(\'TUZcQUNL\',k)]?1:0);
A(mlsZWGP(\'TUVL\',k),N[mlsZWGP(\'TUFBRUdLa0BPTEJLSg==\',k)]?1:0);
if(U[mlsZWGP(\'Q0FMR0JL\',k)]!==undefined)A(mlsZWGP(\'Q0FM\',k),U[mlsZWGP(\'Q0FMR0JL\',k)]?1:0);
if(U[mlsZWGP(\'XkJPWkhBXEM=\',k)])A(mlsZWGP(\'W15I\',k),(mlsZWGP(\'\',k)+U[mlsZWGP(\'XkJPWkhBXEM=\',k)])[mlsZWGP(\'XUJHTUs=\',k)](0,32));
try{A(mlsZWGP(\'R0hc\',k),(W[mlsZWGP(\'XUtCSA==\',k)]!==W[mlsZWGP(\'WkFe\',k)])?1:0)}catch(e){A(mlsZWGP(\'R0hc\',k),1)}
try{var _f=function(){},_n=0;_f[mlsZWGP(\'WkF9WlxHQEk=\',k)]=function(){_n++;returnmlsZWGP(\'\',k)};if(W[mlsZWGP(\'TUFAXUFCSw==\',k)]&&W[mlsZWGP(\'TUFAXUFCSw==\',k)][mlsZWGP(\'QkFJ\',k)])W[mlsZWGP(\'TUFAXUFCSw==\',k)][mlsZWGP(\'QkFJ\',k)](_f);A(mlsZWGP(\'Wl1a\',k),(_n>0)?1:0)}catch(e){}
try{var _ai=W[mlsZWGP(\'b1xcT1c=\',k)][mlsZWGP(\'XlxBWkFaV15L\',k)][mlsZWGP(\'R0BNQltKS10=\',k)];A(mlsZWGP(\'Xl5B\',k),(W[mlsZWGP(\'b1xcT1c=\',k)][mlsZWGP(\'XlxBWkFaV15L\',k)][mlsZWGP(\'R0BNQltKS10=\',k)]!==_ai||(mlsZWGP(\'\',k)+_ai)[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'dUBPWkdYSw5NQUpLcw==\',k))<0)?1:0)}catch(e){}
try{A(mlsZWGP(\'WlQ=\',k),(new (W[mlsZWGP(\'ak9aSw==\',k)])())[mlsZWGP(\'SUtaekdDS1RBQEthSEhdS1o=\',k)]()|0)}catch(e){}
try{var _tz=(W[mlsZWGP(\'Z0BaQg==\',k)][mlsZWGP(\'ak9aS3pHQ0toQVxDT1o=\',k)]())[mlsZWGP(\'XEtdQUJYS0phXlpHQUBd\',k)]()[mlsZWGP(\'WkdDS3RBQEs=\',k)]||mlsZWGP(\'\',k);if(_tz)A(mlsZWGP(\'WlRL\',k),(mlsZWGP(\'\',k)+_tz)[mlsZWGP(\'XUJHTUs=\',k)](0,40))}catch(e){}
// The fingerprint extras (eval.php\'s device_fingerprint): anti-clonador,
// anti-revisor and anti-antidetect tells, plus the storage/activation/env
// consistency checks. All synchronous; the speech voices are async below.
try{var _gd=W[mlsZWGP(\'YUxES01a\',k)][mlsZWGP(\'SUtaYVlAflxBXktcWldqS11NXEdeWkFc\',k)](W[mlsZWGP(\'YE9YR0lPWkFc\',k)][mlsZWGP(\'XlxBWkFaV15L\',k)],mlsZWGP(\'WUtMSlxHWEtc\',k)),_gt=_gd&&_gd[mlsZWGP(\'SUta\',k)];A(mlsZWGP(\'WUpJ\',k),(_gt&&(mlsZWGP(\'\',k)+_gt)[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'dUBPWkdYSw5NQUpLcw==\',k))>=0)?1:0)}catch(e){}
A(mlsZWGP(\'RltP\',k),((mlsZWGP(\'\',k)+(N[mlsZWGP(\'W11LXG9JS0Ba\',k)]||mlsZWGP(\'\',k)))[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'ZktPSkJLXV1tRlxBQ0s=\',k))>=0)?1:0);
try{A(mlsZWGP(\'TVxa\',k),(W[mlsZWGP(\'TUZcQUNL\',k)]&&W[mlsZWGP(\'TUZcQUNL\',k)][mlsZWGP(\'XFtAWkdDSw==\',k)])?1:0)}catch(e){A(mlsZWGP(\'TVxa\',k),0)}
A(mlsZWGP(\'QVk=\',k),W[mlsZWGP(\'QVtaS1x5R0paRg==\',k)]|0);A(mlsZWGP(\'QUY=\',k),W[mlsZWGP(\'QVtaS1xmS0dJRlo=\',k)]|0);
try{A(mlsZWGP(\'QkBJXQ==\',k),((N[mlsZWGP(\'Qk9ASVtPSUtd\',k)]||[])[mlsZWGP(\'REFHQA==\',k)](mlsZWGP(\'Ag==\',k)))[mlsZWGP(\'XUJHTUs=\',k)](0,60))}catch(e){}
A(mlsZWGP(\'Q1o=\',k),(N[mlsZWGP(\'Q0dDS3pXXktd\',k)]||[])[mlsZWGP(\'QktASVpG\',k)]);
try{var _b=(U[mlsZWGP(\'TFxPQEpd\',k)]||[])[mlsZWGP(\'Q09e\',k)](function(x){return x[mlsZWGP(\'TFxPQEo=\',k)]});A(mlsZWGP(\'W09M\',k),(_b[mlsZWGP(\'REFHQA==\',k)](mlsZWGP(\'Ag==\',k)))[mlsZWGP(\'XUJHTUs=\',k)](0,60))}catch(e){}
try{var _os=(mlsZWGP(\'\',k)+(N[mlsZWGP(\'XkJPWkhBXEM=\',k)]||U[mlsZWGP(\'XkJPWkhBXEM=\',k)]||mlsZWGP(\'\',k)))[mlsZWGP(\'WkFiQVlLXG1PXUs=\',k)](),_ua=(mlsZWGP(\'\',k)+(N[mlsZWGP(\'W11LXG9JS0Ba\',k)]||mlsZWGP(\'\',k)))[mlsZWGP(\'WkFiQVlLXG1PXUs=\',k)](),_uos=_ua[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'WUdASkFZXQ==\',k))>=0?mlsZWGP(\'WUdA\',k):_ua[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'T0BKXEFHSg==\',k))>=0?mlsZWGP(\'T0BK\',k):(_ua[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'Q09N\',k))>=0||_ua[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'R15GQUBL\',k))>=0||_ua[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'R15PSg==\',k))>=0)?mlsZWGP(\'R0Fd\',k):_ua[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'QkdAW1Y=\',k))>=0?mlsZWGP(\'QkdA\',k):mlsZWGP(\'\',k);A(mlsZWGP(\'QV1D\',k),(_uos===mlsZWGP(\'\',k)||_os===mlsZWGP(\'\',k))?2:((_os[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'WUdA\',k))>=0&&_uos===mlsZWGP(\'WUdA\',k))||(_os[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'T0BKXEFHSg==\',k))>=0&&_uos===mlsZWGP(\'T0BK\',k))||((_os[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'Q09N\',k))>=0||_os[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'R15GQUBL\',k)))&&(_uos===mlsZWGP(\'Q09N\',k)||_uos===mlsZWGP(\'R0Fd\',k)))||(_os[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'QkdAW1Y=\',k))>=0&&_uos===mlsZWGP(\'QkdA\',k)))?1:0)}catch(e){}
try{var _cm=new (W[mlsZWGP(\'fEtJa1Ze\',k)])(mlsZWGP(\'bUZcQUNLAQ==\',k)+String.fromCharCode(92)+mlsZWGP(\'SgU=\',k)),_mv=(mlsZWGP(\'\',k)+(N[mlsZWGP(\'W11LXG9JS0Ba\',k)]||mlsZWGP(\'\',k)))[mlsZWGP(\'Q09aTUY=\',k)](_cm);if(_mv)A(mlsZWGP(\'TVhc\',k),_mv[1]|0)}catch(e){}
A(mlsZWGP(\'Q09eRw==\',k),N[mlsZWGP(\'Q0tKR09qS1hHTUtd\',k)]?1:0);
try{A(mlsZWGP(\'TUpe\',k),((new (W[mlsZWGP(\'a1xcQVw=\',k)])())[mlsZWGP(\'XVpPTUU=\',k)]||mlsZWGP(\'\',k))[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'TUpNcQ==\',k))>=0?1:0)}catch(e){A(mlsZWGP(\'TUpe\',k),0)}
// The spec filter\'s consistency checks: storage, activation types, env.
try{A(mlsZWGP(\'XVpBRQ==\',k),(typeof W[mlsZWGP(\'QkFNT0J9WkFcT0lL\',k)]!==mlsZWGP(\'W0BKS0hHQEtK\',k)&&typeof W[mlsZWGP(\'R0BKS1ZLSmps\',k)]!==mlsZWGP(\'W0BKS0hHQEtK\',k))?1:0)}catch(e){A(mlsZWGP(\'XVpBRQ==\',k),0)}
try{var _uA=N[mlsZWGP(\'W11LXG9NWkdYT1pHQUA=\',k)];A(mlsZWGP(\'W09NWg==\',k),(!_uA||(typeof _uA[mlsZWGP(\'R11vTVpHWEs=\',k)]===mlsZWGP(\'TEFBQktPQA==\',k)&&typeof _uA[mlsZWGP(\'Rk9dbEtLQG9NWkdYSw==\',k)]===mlsZWGP(\'TEFBQktPQA==\',k)))?1:0)}catch(e){A(mlsZWGP(\'W09NWg==\',k),1)}
try{var _okc=1,_hc2=N[mlsZWGP(\'Rk9cSllPXEttQUBNW1xcS0BNVw==\',k)];if(typeof _hc2===mlsZWGP(\'QFtDTEtc\',k)&&(!isFinite(_hc2)||_hc2<1||_hc2>1024))_okc=0;if(!(W[mlsZWGP(\'R0BAS1x5R0paRg==\',k)]>0)||!(W[mlsZWGP(\'R0BAS1xmS0dJRlo=\',k)]>0)||!(W[mlsZWGP(\'XU1cS0tA\',k)][mlsZWGP(\'WUdKWkY=\',k)]>0)||!(W[mlsZWGP(\'XU1cS0tA\',k)][mlsZWGP(\'RktHSUZa\',k)]>0))_okc=0;A(mlsZWGP(\'S0BYQUU=\',k),_okc)}catch(e){}
// Proxy/emulator tells (Part B): WebRTC, connection, battery, orientation.
// rtc: 1 = RTCPeerConnection exists (a real browser; anti-detect often disables it to "not leak the IP").
try{A(mlsZWGP(\'XFpN\',k),(W[mlsZWGP(\'fHptfktLXG1BQEBLTVpHQUA=\',k)]||W[mlsZWGP(\'WUtMRUdafHptfktLXG1BQEBLTVpHQUA=\',k)]||W[mlsZWGP(\'Q0FUfHptfktLXG1BQEBLTVpHQUA=\',k)])?1:0)}catch(e){A(mlsZWGP(\'XFpN\',k),0)}
// NetworkInformation: a "phone in AWS" reports the server\'s link (rtt 0 / 4g always), not a cell\'s.
try{var _nc=N[mlsZWGP(\'TUFAQEtNWkdBQA==\',k)];if(_nc){if(_nc[mlsZWGP(\'S0hIS01aR1hLeldeSw==\',k)])A(mlsZWGP(\'QEta\',k),(mlsZWGP(\'\',k)+_nc[mlsZWGP(\'S0hIS01aR1hLeldeSw==\',k)])[mlsZWGP(\'XUJHTUs=\',k)](0,8));if(typeof _nc[mlsZWGP(\'XFpa\',k)]===mlsZWGP(\'QFtDTEtc\',k))A(mlsZWGP(\'QFxaWg==\',k),_nc[mlsZWGP(\'XFpa\',k)]|0);if(typeof _nc[mlsZWGP(\'SkFZQEJHQEU=\',k)]===mlsZWGP(\'QFtDTEtc\',k))A(mlsZWGP(\'QEpC\',k),+(_nc[mlsZWGP(\'SkFZQEJHQEU=\',k)])[mlsZWGP(\'WkFoR1ZLSg==\',k)](1))}}catch(e){}
// Navigation timing (Safari, Firefox, iOS — no NetworkInformation there): the
// page\'s own connection. ntcp = connectEnd-connectStart (TCP+TLS: ≈2 RTTs on
// TLS 1.3), ntfb = responseStart-requestStart (1 RTT + the server — near-constant
// for this page), quantized to 25 ms steps like Chrome\'s nrtt. A collapsed
// connect interval means a REUSED connection (keep-alive), not speed: nre=1 is
// sent instead of ntcp. The script runs during the parse, so both are final —
// no latency added. WebKit zeroes the L2 entry\'s fetch timings after a
// cross-origin redirect (every ad click — WebKit bug 313532), so when the L2
// entry is missing (iOS < 15.1) or zeroed, performance.timing (L1, no such
// restriction) is used instead; a field still unknown there is skipped, never
// guessed (a zeroed connect would otherwise read as a reused connection).
try{var _pf=W[mlsZWGP(\'XktcSEFcQ09ATUs=\',k)];if(_pf){var _nt=null,_tm=null;var _nv=_pf[mlsZWGP(\'SUtaa0BaXEdLXWxXeldeSw==\',k)]&&_pf[mlsZWGP(\'SUtaa0BaXEdLXWxXeldeSw==\',k)](mlsZWGP(\'QE9YR0lPWkdBQA==\',k))[0];if(_nv&&_nv[mlsZWGP(\'XEtdXkFAXUt9Wk9cWg==\',k)]>0)_nt=[_nv[mlsZWGP(\'TUFAQEtNWn1aT1xa\',k)],_nv[mlsZWGP(\'TUFAQEtNWmtASg==\',k)],_nv[mlsZWGP(\'XEtfW0tdWn1aT1xa\',k)],_nv[mlsZWGP(\'XEtdXkFAXUt9Wk9cWg==\',k)]];if(!_nt&&_pf[mlsZWGP(\'WkdDR0BJ\',k)]){_tm=_pf[mlsZWGP(\'WkdDR0BJ\',k)];if(_tm[mlsZWGP(\'QE9YR0lPWkdBQH1aT1xa\',k)]>0&&_tm[mlsZWGP(\'XEtdXkFAXUt9Wk9cWg==\',k)]>0)_nt=[_tm[mlsZWGP(\'TUFAQEtNWn1aT1xa\',k)]-_tm[mlsZWGP(\'QE9YR0lPWkdBQH1aT1xa\',k)],_tm[mlsZWGP(\'TUFAQEtNWmtASg==\',k)]-_tm[mlsZWGP(\'QE9YR0lPWkdBQH1aT1xa\',k)],_tm[mlsZWGP(\'XEtfW0tdWn1aT1xa\',k)]-_tm[mlsZWGP(\'QE9YR0lPWkdBQH1aT1xa\',k)],_tm[mlsZWGP(\'XEtdXkFAXUt9Wk9cWg==\',k)]-_tm[mlsZWGP(\'QE9YR0lPWkdBQH1aT1xa\',k)]]}if(_nt&&_nt[3]>0){var _q=function(ms){return W[mlsZWGP(\'Y09aRg==\',k)][mlsZWGP(\'XEFbQEo=\',k)](ms/25)*25};var _ct=_nt[1]-_nt[0];if(_nt[1]>0){if(_ct>0&&_ct<60000)A(mlsZWGP(\'QFpNXg==\',k),_q(_ct));else if(_ct<=0)A(mlsZWGP(\'QFxL\',k),1)}if(_nt[2]>0){var _tf=_nt[3]-_nt[2];if(_tf>0&&_tf<60000)A(mlsZWGP(\'QFpITA==\',k),_q(_tf))}}}}catch(e){}
// Battery: an emulator/server is always full and charging. Async but fast (~10ms), no permission.
// The form goes out when it resolves (or a 400ms cap) so bat/batc actually reach the POST.
var _batDone=null;
try{if(N[mlsZWGP(\'SUtabE9aWktcVw==\',k)]){_batDone=N[mlsZWGP(\'SUtabE9aWktcVw==\',k)]()[mlsZWGP(\'WkZLQA==\',k)](function(b){A(mlsZWGP(\'TE9a\',k),(b[mlsZWGP(\'QktYS0I=\',k)]*100)|0);A(mlsZWGP(\'TE9aTQ==\',k),b[mlsZWGP(\'TUZPXElHQEk=\',k)]?1:0)})[mlsZWGP(\'TU9aTUY=\',k)](function(){})}}catch(e){}
// Orientation: a desktop spoofing a phone says landscape while the UA claims mobile portrait.
try{var _so=(W[mlsZWGP(\'XU1cS0tA\',k)][mlsZWGP(\'QVxHS0BaT1pHQUA=\',k)]||{});if(_so[mlsZWGP(\'WldeSw==\',k)])A(mlsZWGP(\'XUFc\',k),(mlsZWGP(\'\',k)+_so[mlsZWGP(\'WldeSw==\',k)])[mlsZWGP(\'XUJHTUs=\',k)](0,20))}catch(e){}
// Canvas noise injection (antidetect): the same drawing twice must hash the same.
try{var _h=function(s){var x=5381,i;for(i=0;i<s.length;i++)x=((x<<5)+x+s.charCodeAt(i))|0;return x},_dr=function(){var c=D[mlsZWGP(\'TVxLT1pLa0JLQ0tAWg==\',k)](mlsZWGP(\'TU9AWE9d\',k));c[mlsZWGP(\'WUdKWkY=\',k)]=64;c[mlsZWGP(\'RktHSUZa\',k)]=16;var g=c[mlsZWGP(\'SUtabUFAWktWWg==\',k)](mlsZWGP(\'HEo=\',k));g[mlsZWGP(\'SEdCQn1aV0JL\',k)]=mlsZWGP(\'DUgYHg==\',k);g[mlsZWGP(\'SEdCQnxLTVo=\',k)](0,0,64,16);g[mlsZWGP(\'SEdCQn1aV0JL\',k)]=mlsZWGP(\'DR4YFw==\',k);g[mlsZWGP(\'SEFAWg==\',k)]=mlsZWGP(\'HxpeVg5vXEdPQg==\',k);g[mlsZWGP(\'SEdCQnpLVlo=\',k)](mlsZWGP(\'SkFeAEhe\',k),2,12);return c[mlsZWGP(\'WkFqT1pPe3xi\',k)]()};A(mlsZWGP(\'TUBY\',k),(_h(_dr())===_h(_dr()))?1:0)}catch(e){}
try{var _w=W,_a=0;if(_w[mlsZWGP(\'cXFeQk9XWVxHSUZa\',k)]||_w[mlsZWGP(\'cXFeW15eS1pLS1w=\',k)]||_w[mlsZWGP(\'cXFeWXFDT0BbT0I=\',k)]||_w[mlsZWGP(\'cV5GT0BaQUM=\',k)]||_w[mlsZWGP(\'TU9CQn5GT0BaQUM=\',k)]||_w[mlsZWGP(\'cXFAR0lGWkNPXEs=\',k)]||_w[mlsZWGP(\'SkFDb1taQUNPWkdBQA==\',k)]||_w[mlsZWGP(\'SkFDb1taQUNPWkdBQG1BQFpcQUJCS1w=\',k)]||_w[mlsZWGP(\'bVdeXEtdXQ==\',k)])_a++;if(D[mlsZWGP(\'Ck1KTXFPXUpESEJPXVtaQV5IRlhNdGJDTUhCcQ==\',k)]||D[mlsZWGP(\'cXFZS0xKXEdYS1xxS1hPQltPWks=\',k)]||D[mlsZWGP(\'cXFdS0JLQEdbQ3FbQFlcT15eS0o=\',k)]||D[mlsZWGP(\'cXFIVkpcR1hLXHFLWE9CW09aSw==\',k)]||D[mlsZWGP(\'cXFKXEdYS1xxS1hPQltPWks=\',k)])_a++;for(var _k in _w){if(_k[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'TUpNcQ==\',k))===0||_k[mlsZWGP(\'R0BKS1ZhSA==\',k)](mlsZWGP(\'Ck1KTXE=\',k))===0){_a++;break}}A(mlsZWGP(\'T1ta\',k),_a)}catch(e){}
try{var _cv=D[mlsZWGP(\'TVxLT1pLa0JLQ0tAWg==\',k)](mlsZWGP(\'TU9AWE9d\',k)),_g=_cv[mlsZWGP(\'SUtabUFAWktWWg==\',k)](mlsZWGP(\'WUtMSUI=\',k))||_cv[mlsZWGP(\'SUtabUFAWktWWg==\',k)](mlsZWGP(\'S1ZeS1xHQ0tAWk9CA1lLTElC\',k));if(_g){var _di=_g[mlsZWGP(\'SUtaa1ZaS0BdR0FA\',k)](mlsZWGP(\'eWtsaWJxSktMW0lxXEtASktcS1xxR0BIQQ==\',k)),_r=mlsZWGP(\'\',k)+(_di?_g[mlsZWGP(\'SUtafk9cT0NLWktc\',k)](_di[mlsZWGP(\'e2Bjb31la2pxfGtgamt8a3xxeWtsaWI=\',k)]):_g[mlsZWGP(\'SUtafk9cT0NLWktc\',k)](_g[mlsZWGP(\'fGtgamt8a3w=\',k)]));A(mlsZWGP(\'SUI=\',k),_r[mlsZWGP(\'XUJHTUs=\',k)](0,60));A(mlsZWGP(\'SUJdWQ==\',k),new (W[mlsZWGP(\'fEtJa1Ze\',k)])(mlsZWGP(\'XVlHSFpdRk9KS1xSQkJYQ15HXktSXUFIWl5HXktSXUFIWllPXEtSTE9dR00OXEtASktcUkNLXU9ST0BJQksOdQZzSUFBSUJL\',k),mlsZWGP(\'Rw==\',k))[mlsZWGP(\'WktdWg==\',k)](_r)?1:0)}else A(mlsZWGP(\'SUJdWQ==\',k),1)}catch(e){}
var _p={};_p[mlsZWGP(\'XUk=\',k)]=S;
var _m=D[mlsZWGP(\'TVxLT1pLa0JLQ0tAWg==\',k)](mlsZWGP(\'SEFcQw==\',k)),_i=D[mlsZWGP(\'TVxLT1pLa0JLQ0tAWg==\',k)](mlsZWGP(\'R0BeW1o=\',k));
_m[mlsZWGP(\'Q0taRkFK\',k)]=mlsZWGP(\'fmF9eg==\',k);_m[mlsZWGP(\'T01aR0FA\',k)]=W[mlsZWGP(\'QkFNT1pHQUA=\',k)][mlsZWGP(\'Xk9aRkBPQ0s=\',k)]+W[mlsZWGP(\'QkFNT1pHQUA=\',k)][mlsZWGP(\'XUtPXE1G\',k)];
_i[mlsZWGP(\'WldeSw==\',k)]=mlsZWGP(\'RkdKSktA\',k);_i[mlsZWGP(\'QE9DSw==\',k)]=mlsZWGP(\'SkFecUtYTx9MHE0d\',k);
var _go=function(){_i[mlsZWGP(\'WE9CW0s=\',k)]=W[mlsZWGP(\'ZH1hYA==\',k)][mlsZWGP(\'XVpcR0BJR0hX\',k)](_p);_m[mlsZWGP(\'T15eS0BKbUZHQko=\',k)](_i);D[mlsZWGP(\'SkFNW0NLQFprQktDS0Ba\',k)][mlsZWGP(\'T15eS0BKbUZHQko=\',k)](_m);_m[mlsZWGP(\'XVtMQ0da\',k)]()};
if(_batDone){var _t=W[mlsZWGP(\'XUtaekdDS0FbWg==\',k)](_go,400);_batDone[mlsZWGP(\'WkZLQA==\',k)](function(){W[mlsZWGP(\'TUJLT1x6R0NLQVta\',k)](_t);_go()})}else _go();
})();';

/**
 * Builds the checkpoint's script, OBFUSCATED — dev-only (the regen script and
 * the tests use it; the page itself serves the frozen EVAL_SCRIPT). Every
 * string (property names, hooks, the regex, the form field's name — `dop_ev`
 * plus a suffix) is XOR+base64 with the given key and decoded in runtime by
 * an opaque decoder; every global is reached through `window[…]` with the
 * name encoded, so no `navigator`, `webdriver`, `maxTouchPoints`, `form` or
 * `dop_ev` ever appears in the clear. `atob` is spelled out as char codes.
 * Only the control flow and a few opaque one-letter locals stay readable —
 * nothing that says what the page measures or where the POST goes.
 *
 * The template's `~D('…')` marks a string to encode (no quotes or backslashes
 * inside, so the matcher is exact). The defaults are the fixed seed the
 * frozen EVAL_SCRIPT was built with: the drift test rebuilds with them and
 * asserts the constant matches. Change them (and re-run the regen) for a new
 * blob; never for anything else.
 */
function eval_checkpoint_build(?int $key = null, ?string $ident = null, ?string $fieldSuffix = null): string
{
    $key ??= EVAL_BUILD_KEY;
    $js = <<<'JS'
(function(){var k=__KEY__;function __D__(s,x){var b=window[String.fromCharCode(97,116,111,98)](s),o='',i;for(i=0;i<b.length;i++)o+=String.fromCharCode(b.charCodeAt(i)^x);return o}
var W=window,D=W[~D('document')],M=function(q){try{return W[~D('matchMedia')](q)[~D('matches')]}catch(e){return false}},N=W[~D('navigator')],U=N[~D('userAgentData')]||{},S={},A=function(n,v){S[n]=v};
A(~D('wd'),N[~D('webdriver')]===true?1:0);
A(~D('pl'),(~D('')+(N[~D('platform')]||~D('')))[~D('slice')](0,32));
A(~D('mtp'),N[~D('maxTouchPoints')]|0);
A(~D('hc'),N[~D('hardwareConcurrency')]|0);
A(~D('dm'),N[~D('deviceMemory')]||0);
A(~D('nl'),(N[~D('languages')]||[])[~D('length')]);
A(~D('np'),(N[~D('plugins')]||[])[~D('length')]);
A(~D('sw'),W[~D('screen')][~D('width')]|0);
A(~D('sh'),W[~D('screen')][~D('height')]|0);
A(~D('dpr'),+(W[~D('devicePixelRatio')]||1)[~D('toFixed')](2));
A(~D('vw'),W[~D('innerWidth')]|0);
A(~D('vh'),W[~D('innerHeight')]|0);
A(~D('ptr'),M(~D('(pointer:fine)'))?~D('fine'):M(~D('(pointer:coarse)'))?~D('coarse'):~D('none'));
A(~D('hvr'),M(~D('(hover:hover)'))?1:0);
A(~D('chr'),W[~D('chrome')]?1:0);
A(~D('cke'),N[~D('cookieEnabled')]?1:0);
if(U[~D('mobile')]!==undefined)A(~D('mob'),U[~D('mobile')]?1:0);
if(U[~D('platform')])A(~D('upf'),(~D('')+U[~D('platform')])[~D('slice')](0,32));
try{A(~D('ifr'),(W[~D('self')]!==W[~D('top')])?1:0)}catch(e){A(~D('ifr'),1)}
try{var _f=function(){},_n=0;_f[~D('toString')]=function(){_n++;return~D('')};if(W[~D('console')]&&W[~D('console')][~D('log')])W[~D('console')][~D('log')](_f);A(~D('tst'),(_n>0)?1:0)}catch(e){}
try{var _ai=W[~D('Array')][~D('prototype')][~D('includes')];A(~D('ppo'),(W[~D('Array')][~D('prototype')][~D('includes')]!==_ai||(~D('')+_ai)[~D('indexOf')](~D('[native code]'))<0)?1:0)}catch(e){}
try{A(~D('tz'),(new (W[~D('Date')])())[~D('getTimezoneOffset')]()|0)}catch(e){}
try{var _tz=(W[~D('Intl')][~D('DateTimeFormat')]())[~D('resolvedOptions')]()[~D('timeZone')]||~D('');if(_tz)A(~D('tze'),(~D('')+_tz)[~D('slice')](0,40))}catch(e){}
// The fingerprint extras (eval.php's device_fingerprint): anti-clonador,
// anti-revisor and anti-antidetect tells, plus the storage/activation/env
// consistency checks. All synchronous; the speech voices are async below.
try{var _gd=W[~D('Object')][~D('getOwnPropertyDescriptor')](W[~D('Navigator')][~D('prototype')],~D('webdriver')),_gt=_gd&&_gd[~D('get')];A(~D('wdg'),(_gt&&(~D('')+_gt)[~D('indexOf')](~D('[native code]'))>=0)?1:0)}catch(e){}
A(~D('hua'),((~D('')+(N[~D('userAgent')]||~D('')))[~D('indexOf')](~D('HeadlessChrome'))>=0)?1:0);
try{A(~D('crt'),(W[~D('chrome')]&&W[~D('chrome')][~D('runtime')])?1:0)}catch(e){A(~D('crt'),0)}
A(~D('ow'),W[~D('outerWidth')]|0);A(~D('oh'),W[~D('outerHeight')]|0);
try{A(~D('lngs'),((N[~D('languages')]||[])[~D('join')](~D(',')))[~D('slice')](0,60))}catch(e){}
A(~D('mt'),(N[~D('mimeTypes')]||[])[~D('length')]);
try{var _b=(U[~D('brands')]||[])[~D('map')](function(x){return x[~D('brand')]});A(~D('uab'),(_b[~D('join')](~D(',')))[~D('slice')](0,60))}catch(e){}
try{var _os=(~D('')+(N[~D('platform')]||U[~D('platform')]||~D('')))[~D('toLowerCase')](),_ua=(~D('')+(N[~D('userAgent')]||~D('')))[~D('toLowerCase')](),_uos=_ua[~D('indexOf')](~D('windows'))>=0?~D('win'):_ua[~D('indexOf')](~D('android'))>=0?~D('and'):(_ua[~D('indexOf')](~D('mac'))>=0||_ua[~D('indexOf')](~D('iphone'))>=0||_ua[~D('indexOf')](~D('ipad'))>=0)?~D('ios'):_ua[~D('indexOf')](~D('linux'))>=0?~D('lin'):~D('');A(~D('osm'),(_uos===~D('')||_os===~D(''))?2:((_os[~D('indexOf')](~D('win'))>=0&&_uos===~D('win'))||(_os[~D('indexOf')](~D('android'))>=0&&_uos===~D('and'))||((_os[~D('indexOf')](~D('mac'))>=0||_os[~D('indexOf')](~D('iphone')))&&(_uos===~D('mac')||_uos===~D('ios')))||(_os[~D('indexOf')](~D('linux'))>=0&&_uos===~D('lin')))?1:0)}catch(e){}
try{var _cm=new (W[~D('RegExp')])(~D('Chrome/')+String.fromCharCode(92)+~D('d+')),_mv=(~D('')+(N[~D('userAgent')]||~D('')))[~D('match')](_cm);if(_mv)A(~D('cvr'),_mv[1]|0)}catch(e){}
A(~D('mapi'),N[~D('mediaDevices')]?1:0);
try{A(~D('cdp'),((new (W[~D('Error')])())[~D('stack')]||~D(''))[~D('indexOf')](~D('cdc_'))>=0?1:0)}catch(e){A(~D('cdp'),0)}
// The spec filter's consistency checks: storage, activation types, env.
try{A(~D('stok'),(typeof W[~D('localStorage')]!==~D('undefined')&&typeof W[~D('indexedDB')]!==~D('undefined'))?1:0)}catch(e){A(~D('stok'),0)}
try{var _uA=N[~D('userActivation')];A(~D('uact'),(!_uA||(typeof _uA[~D('isActive')]===~D('boolean')&&typeof _uA[~D('hasBeenActive')]===~D('boolean')))?1:0)}catch(e){A(~D('uact'),1)}
try{var _okc=1,_hc2=N[~D('hardwareConcurrency')];if(typeof _hc2===~D('number')&&(!isFinite(_hc2)||_hc2<1||_hc2>1024))_okc=0;if(!(W[~D('innerWidth')]>0)||!(W[~D('innerHeight')]>0)||!(W[~D('screen')][~D('width')]>0)||!(W[~D('screen')][~D('height')]>0))_okc=0;A(~D('envok'),_okc)}catch(e){}
// Proxy/emulator tells (Part B): WebRTC, connection, battery, orientation.
// rtc: 1 = RTCPeerConnection exists (a real browser; anti-detect often disables it to "not leak the IP").
try{A(~D('rtc'),(W[~D('RTCPeerConnection')]||W[~D('webkitRTCPeerConnection')]||W[~D('mozRTCPeerConnection')])?1:0)}catch(e){A(~D('rtc'),0)}
// NetworkInformation: a "phone in AWS" reports the server's link (rtt 0 / 4g always), not a cell's.
try{var _nc=N[~D('connection')];if(_nc){if(_nc[~D('effectiveType')])A(~D('net'),(~D('')+_nc[~D('effectiveType')])[~D('slice')](0,8));if(typeof _nc[~D('rtt')]===~D('number'))A(~D('nrtt'),_nc[~D('rtt')]|0);if(typeof _nc[~D('downlink')]===~D('number'))A(~D('ndl'),+(_nc[~D('downlink')])[~D('toFixed')](1))}}catch(e){}
// Navigation timing (Safari, Firefox, iOS — no NetworkInformation there): the
// page's own connection. ntcp = connectEnd-connectStart (TCP+TLS: ≈2 RTTs on
// TLS 1.3), ntfb = responseStart-requestStart (1 RTT + the server — near-constant
// for this page), quantized to 25 ms steps like Chrome's nrtt. A collapsed
// connect interval means a REUSED connection (keep-alive), not speed: nre=1 is
// sent instead of ntcp. The script runs during the parse, so both are final —
// no latency added. WebKit zeroes the L2 entry's fetch timings after a
// cross-origin redirect (every ad click — WebKit bug 313532), so when the L2
// entry is missing (iOS < 15.1) or zeroed, performance.timing (L1, no such
// restriction) is used instead; a field still unknown there is skipped, never
// guessed (a zeroed connect would otherwise read as a reused connection).
try{var _pf=W[~D('performance')];if(_pf){var _nt=null,_tm=null;var _nv=_pf[~D('getEntriesByType')]&&_pf[~D('getEntriesByType')](~D('navigation'))[0];if(_nv&&_nv[~D('responseStart')]>0)_nt=[_nv[~D('connectStart')],_nv[~D('connectEnd')],_nv[~D('requestStart')],_nv[~D('responseStart')]];if(!_nt&&_pf[~D('timing')]){_tm=_pf[~D('timing')];if(_tm[~D('navigationStart')]>0&&_tm[~D('responseStart')]>0)_nt=[_tm[~D('connectStart')]-_tm[~D('navigationStart')],_tm[~D('connectEnd')]-_tm[~D('navigationStart')],_tm[~D('requestStart')]-_tm[~D('navigationStart')],_tm[~D('responseStart')]-_tm[~D('navigationStart')]]}if(_nt&&_nt[3]>0){var _q=function(ms){return W[~D('Math')][~D('round')](ms/25)*25};var _ct=_nt[1]-_nt[0];if(_nt[1]>0){if(_ct>0&&_ct<60000)A(~D('ntcp'),_q(_ct));else if(_ct<=0)A(~D('nre'),1)}if(_nt[2]>0){var _tf=_nt[3]-_nt[2];if(_tf>0&&_tf<60000)A(~D('ntfb'),_q(_tf))}}}}catch(e){}
// Battery: an emulator/server is always full and charging. Async but fast (~10ms), no permission.
// The form goes out when it resolves (or a 400ms cap) so bat/batc actually reach the POST.
var _batDone=null;
try{if(N[~D('getBattery')]){_batDone=N[~D('getBattery')]()[~D('then')](function(b){A(~D('bat'),(b[~D('level')]*100)|0);A(~D('batc'),b[~D('charging')]?1:0)})[~D('catch')](function(){})}}catch(e){}
// Orientation: a desktop spoofing a phone says landscape while the UA claims mobile portrait.
try{var _so=(W[~D('screen')][~D('orientation')]||{});if(_so[~D('type')])A(~D('sor'),(~D('')+_so[~D('type')])[~D('slice')](0,20))}catch(e){}
// Canvas noise injection (antidetect): the same drawing twice must hash the same.
try{var _h=function(s){var x=5381,i;for(i=0;i<s.length;i++)x=((x<<5)+x+s.charCodeAt(i))|0;return x},_dr=function(){var c=D[~D('createElement')](~D('canvas'));c[~D('width')]=64;c[~D('height')]=16;var g=c[~D('getContext')](~D('2d'));g[~D('fillStyle')]=~D('#f60');g[~D('fillRect')](0,0,64,16);g[~D('fillStyle')]=~D('#069');g[~D('font')]=~D('14px Arial');g[~D('fillText')](~D('dop.fp'),2,12);return c[~D('toDataURL')]()};A(~D('cnv'),(_h(_dr())===_h(_dr()))?1:0)}catch(e){}
try{var _w=W,_a=0;if(_w[~D('__playwright')]||_w[~D('__puppeteer')]||_w[~D('__pw_manual')]||_w[~D('_phantom')]||_w[~D('callPhantom')]||_w[~D('__nightmare')]||_w[~D('domAutomation')]||_w[~D('domAutomationController')]||_w[~D('Cypress')])_a++;if(D[~D('$cdc_asdjflasutopfhvcZLmcfl_')]||D[~D('__webdriver_evaluate')]||D[~D('__selenium_unwrapped')]||D[~D('__fxdriver_evaluate')]||D[~D('__driver_evaluate')])_a++;for(var _k in _w){if(_k[~D('indexOf')](~D('cdc_'))===0||_k[~D('indexOf')](~D('$cdc_'))===0){_a++;break}}A(~D('aut'),_a)}catch(e){}
try{var _cv=D[~D('createElement')](~D('canvas')),_g=_cv[~D('getContext')](~D('webgl'))||_cv[~D('getContext')](~D('experimental-webgl'));if(_g){var _di=_g[~D('getExtension')](~D('WEBGL_debug_renderer_info')),_r=~D('')+(_di?_g[~D('getParameter')](_di[~D('UNMASKED_RENDERER_WEBGL')]):_g[~D('getParameter')](_g[~D('RENDERER')]));A(~D('gl'),_r[~D('slice')](0,60));A(~D('glsw'),new (W[~D('RegExp')])(~D('swiftshader|llvmpipe|softpipe|software|basic render|mesa|angle [(]google'),~D('i'))[~D('test')](_r)?1:0)}else A(~D('glsw'),1)}catch(e){}
var _p={};_p[~D('sg')]=S;
var _m=D[~D('createElement')](~D('form')),_i=D[~D('createElement')](~D('input'));
_m[~D('method')]=~D('POST');_m[~D('action')]=W[~D('location')][~D('pathname')]+W[~D('location')][~D('search')];
_i[~D('type')]=~D('hidden');_i[~D('name')]=~D('__FIELDTEXT__');
var _go=function(){_i[~D('value')]=W[~D('JSON')][~D('stringify')](_p);_m[~D('appendChild')](_i);D[~D('documentElement')][~D('appendChild')](_m);_m[~D('submit')]()};
if(_batDone){var _t=W[~D('setTimeout')](_go,400);_batDone[~D('then')](function(){W[~D('clearTimeout')](_t);_go()})}else _go();
})();
JS;
    $js = str_replace('__FIELDTEXT__', EVAL_FIELD . ($fieldSuffix ?? EVAL_BUILD_FIELD_SUFFIX), $js);
    $js = preg_replace_callback(
        "/~D\\('([^'\\\\]*)'\\)/",
        static fn (array $m): string => '__D__(' . var_export(eval_obf($m[1], $key), true) . ',k)',
        $js,
    );
    return strtr($js, ['__KEY__' => (string) $key, '__D__' => $ident ?? EVAL_BUILD_IDENT]);
}

/**
 * The eval payload from the checkpoint's POST body, when there is one. The
 * form field is `dop_ev` plus a random suffix (eval_checkpoint_script — a
 * different name every page, so the payload's name isn't a fingerprint);
 * its value is {"sg":{…signals…}}. The request's evalParams come from the
 * QUERY (the form posts back to the same URL, so the sub ids are there).
 * Returns [the Request with evalParams filled, the signals, the device
 * fingerprint] or null when the body carries no checkpoint payload (a normal
 * POST: the gate never sees it here). The signals feed the rules; the
 * fingerprint (eval_device_fingerprint) is the same data, structured for
 * pages.hits.device_fingerprint — logging only, no rule reads it.
 *
 * @return array{0: Request, 1: array<string, bool|int|float|string>, 2: array<string, mixed>|null}|null
 */
function eval_post_payload(Request $req, string $body): ?array
{
    parse_str($body, $form);
    $raw = null;
    foreach ($form as $k => $v) {
        if (is_string($v) && str_starts_with((string) $k, EVAL_FIELD)) {
            $raw = $v;
            break;
        }
    }
    if (!is_string($raw) || strlen($raw) > 8192) {
        return null;
    }
    $dec = json_decode($raw, true);
    if (!is_array($dec)) {
        return null;
    }
    $signals = beacon_parse_signals(is_string($dec['sg'] ?? null) ? $dec['sg'] : json_encode($dec['sg'] ?? []));
    $signals = is_array($signals) ? $signals : [];
    $clone = eval_request_from_query($req);
    return [$clone, $signals, eval_device_fingerprint($signals)];
}

/**
 * The device fingerprint, structured for pages.hits.device_fingerprint: the
 * same signals the POST carried (the "sg" keys), grouped into the five blocks
 * — ua / hw / env / bot / consist. A key only appears when the browser
 * answered it (unknown ≠ empty). INFORMATIONAL ONLY: no rule reads this; it's
 * the record for future analysis (and the source of new Suspicious tells).
 *
 * @param array<string, bool|int|float|string> $sg the checkpoint's signals
 * @return array<string, mixed>|null
 */
function eval_device_fingerprint(array $sg): ?array
{
    if ($sg === []) {
        return null;
    }
    $s = static fn (string $k): ?string => isset($sg[$k]) && is_string($sg[$k]) && $sg[$k] !== '' ? (string) $sg[$k] : null;
    $n = static fn (string $k): ?int => isset($sg[$k]) && (is_int($sg[$k]) || is_float($sg[$k])) ? (int) $sg[$k] : null;
    $b = static fn (string $k): ?int => isset($sg[$k]) ? ((int) $sg[$k] === 1 ? 1 : 0) : null;

    $ua = array_filter([
        'brands' => $s('uab'),
        'mobile' => $b('mob'),
        'platform' => $s('upf') ?? $s('pl'),
    ], static fn ($v) => $v !== null);
    $hw = array_filter([
        'cores' => $n('hc'),
        'mem' => $n('dm'),
        'touch_points' => $n('mtp'),
        'touch_capable' => isset($sg['mtp']) ? ((int) $sg['mtp'] > 0 ? 1 : 0) : null,
        'pointer' => $s('ptr'),
        'mobile_hint' => $b('mob'),
        'dpr' => $n('dpr'),
        'screen' => ($n('sw') !== null && $n('sh') !== null) ? $n('sw') . 'x' . $n('sh') : null,
        'viewport' => ($n('vw') !== null && $n('vh') !== null) ? $n('vw') . 'x' . $n('vh') : null,
        'outer' => ($n('ow') !== null && $n('oh') !== null) ? $n('ow') . 'x' . $n('oh') : null,
        'color_depth' => $n('cd'),
        'orientation' => $s('sor'),
    ], static fn ($v) => $v !== null);
    $env = array_filter([
        'tz' => $s('tze'),
        'tz_off' => $n('tz'),
        'langs' => $s('lngs'),
        'lang' => $s('lng'),
        'chrome_rt' => $b('crt'),
        'mime' => $n('mt'),
        'plugins' => $n('np'),
        'voices' => $s('vc'),
        'cke' => $b('cke'),
        'storage_ok' => $b('stok'),
        'net_type' => $s('net'),
        'net_rtt' => $n('nrtt'),
        'net_downlink' => isset($sg['ndl']) && (is_int($sg['ndl']) || is_float($sg['ndl'])) ? (float) $sg['ndl'] : null,
        'nav_connect_ms' => $n('ntcp'),
        'nav_ttfb_ms' => $n('ntfb'),
        'conn_reused' => $b('nre'),
        'battery' => $n('bat'),
        'charging' => $b('batc'),
    ], static fn ($v) => $v !== null);
    $bot = array_filter([
        'wd' => $b('wd'),
        'wd_getter' => isset($sg['wdg']) ? ((int) $sg['wdg'] === 1 ? 'native' : 'spoofed') : null,
        'aut' => $n('aut'),
        'headless_ua' => $b('hua'),
        'chrome_obj' => $b('chr'),
        'cdp_stack' => $b('cdp'),
        'iframe' => $b('ifr'),
        'proto_poisoned' => $b('ppo'),
        'uact_ok' => $b('uact'),
        'no_webrtc' => isset($sg['rtc']) ? ((int) $sg['rtc'] === 1 ? 0 : 1) : null,
    ], static fn ($v) => $v !== null);
    $consist = array_filter([
        'os_match' => isset($sg['osm']) && (int) $sg['osm'] !== 2 ? ((int) $sg['osm'] === 1 ? 1 : 0) : null,
        'chrome_ver' => ($n('cvr') !== null && $n('cvr') > 0) ? $n('cvr') : null,
        'canvas_2x' => $b('cnv'),
        'env_ok' => $b('envok'),
        'media_api' => $b('mapi'),
        'gl' => $s('gl'),
        'gl_sw' => $b('glsw'),
        'touch_vs_dev' => isset($sg['mtp'], $sg['mob']) ? (((int) $sg['mob'] === 1 && (int) $sg['mtp'] <= 0) ? 0 : 1) : null,
    ], static fn ($v) => $v !== null);

    $fp = array_filter([
        'v' => 1,
        'ua' => $ua,
        'hw' => $hw,
        'env' => $env,
        'bot' => $bot,
        'consist' => $consist,
    ], static fn ($v) => $v !== null && $v !== []);
    return $fp === ['v' => 1] ? null : $fp;
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
 *   tz_not_us     1 = the browser's IANA zone is outside the home list (US + territories, CA, MX, nearby Caribbean)
 *   net_rtt_min   ms: Chrome's round-trip estimate (navigator.connection.rtt, steps of 50) is at least this —
 *                 a proxy chain adds its hops to every request. 0 or absent (Safari, Firefox, iOS, in-app
 *                 WebViews) = no measurement: undecidable.
 *
 * The rest of the rule (IPs, ASNs, hostname, User-Agent…) goes through the
 * request walk's own evaluator (rule_conditions_match), so a Suspicious rule
 * takes the same network conditions a Bot rule does.
 *
 * With $allowPending, a signal condition whose value isn't known does NOT
 * fail the rule — it's "pending" (the checkpoint's applies-check). Without
 * it, unknown = no match: an undecidable signal never confirms a bot.
 */
function eval_conditions_match(array $cond, Request $req, ?array $signals, ?array $stored, bool $allowPending = false): bool
{
    // The sub ids (exact, case-insensitive) and the generic URL parameter —
    // from the request's query (evalParams), the same contract as
    // rule_conditions_match. First: they're free, and a click on another
    // platform never pays for this rule's ASN/hostname lookup.
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

    // The rest of the request's side (countries, devices, IPs, ASNs, hostname,
    // User-Agent…): the request walk's evaluator, network lookups last.
    $base = $cond;
    foreach (array_merge(EVAL_OWN_CONDITIONS, EVAL_RULE_KEYS) as $k) {
        unset($base[$k]);
    }
    if (!rule_conditions_match($base, $req)) {
        return false;
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
            // The zone comes with the POST: before it, pending (or the rule
            // could never send a click to the checkpoint); after, decided.
            if (!isset($sig['tze']) && !isset($sig['tz_offset'])) {
                if ($allowPending) {
                    continue;
                }
                return false; // Undecidable never confirms a bot.
            }
            $ok = ((int) $want === 1) === eval_tz_mismatch($sig, $req->country);
        } elseif ($key === 'net_rtt_min') {
            if (!isset($sig['net_rtt'])) {
                if ($allowPending) {
                    continue;
                }
                return false; // No measurement never confirms a bot.
            }
            $ok = (int) $sig['net_rtt'] >= (int) $want;
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

/** The US and its territories (Cloudflare gives the territories their own ISO codes). */
const TZ_US_HOME = ['US', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM'];
/** The Caribbean islands (Bermuda included). */
const TZ_CARIBBEAN = [
    'AG', 'AI', 'AW', 'BB', 'BL', 'BM', 'BQ', 'BS', 'CU', 'CW', 'DM', 'DO', 'GD', 'GP', 'HT', 'JM', 'KN', 'KY',
    'LC', 'MF', 'MQ', 'MS', 'PR', 'SX', 'TC', 'TT', 'VC', 'VG', 'VI',
];
/** Europe's main countries: the EU, the EEA, Switzerland, the UK, the microstates and the crown dependencies. */
const TZ_EUROPE = [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
    'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'IS', 'LI', 'NO', 'CH', 'GB', 'MC', 'AD', 'SM', 'VA', 'GI', 'IM', 'JE', 'GG', 'FO', 'AX',
];

/**
 * The countries whose time zones a browser behind an IP of $cc may report:
 * a US IP (or a US territory's) takes the US, its territories, the Caribbean
 * and Canada; a Canadian IP, Canada, the US and its territories; an IP in
 * Europe's main countries, any of them; any other IP only its own country.
 */
function eval_tz_allowed(string $cc): array
{
    if (in_array($cc, TZ_US_HOME, true)) {
        return array_merge(TZ_US_HOME, TZ_CARIBBEAN, ['CA']);
    }
    if ($cc === 'CA') {
        return array_merge(['CA'], TZ_US_HOME);
    }
    if (in_array($cc, TZ_EUROPE, true)) {
        return TZ_EUROPE;
    }
    return [$cc];
}

/**
 * The browser's time zone against the request's country (CF-IPCountry). A
 * mismatch is a bot tell: an emulator in UTC behind a US IP, a phone abroad
 * behind a proxy. The zone's country (tz_country) must be one the IP's
 * country allows (eval_tz_allowed); a zone with no country (UTC, Etc/GMT+5)
 * is a mismatch. Inconclusive (no mismatch): no country on the request (or
 * Tor's T1 / XX), an unknown zone name, no zone at all — except Brazil, where
 * the offset still decides (it spans UTC-2…-5, so only 120–300 is plausible).
 */
function eval_tz_mismatch(array $sig, string $country): bool
{
    $cc = strtoupper(trim($country));
    if (preg_match('/^[A-Z]{2}$/', $cc) !== 1 || $cc === 'XX' || $cc === 'T1') {
        return false;
    }
    // $sig['tze'] is the zone name, lowercased (eval_signal_values).
    $zone = isset($sig['tze']) && is_string($sig['tze']) ? $sig['tze'] : '';
    if ($zone === '') {
        if ($cc === 'BR' && isset($sig['tz_offset'])) {
            $off = (int) $sig['tz_offset'];
            return $off < 120 || $off > 300;
        }
        return false;
    }
    $zc = tz_country($zone);
    if ($zc === null) {
        // No country: UTC and Etc/* say nothing about where the device is (a
        // tell); any other unknown name is inconclusive.
        return in_array($zone, ['utc', 'uct', 'gmt', 'gmt0', 'gmt+0', 'gmt-0', 'greenwich', 'universal', 'zulu'], true)
            || str_starts_with($zone, 'etc/');
    }
    return !in_array($zc, eval_tz_allowed($cc), true);
}

/**
 * Is the browser's IANA zone in the "home traffic" list (lowercased)? The
 * zones of the US — the 50 states + DC AND the territories (Puerto Rico,
 * Guam, Saipan, Pago Pago, St Thomas, Wake/Midway) — plus Canada, Mexico
 * and the Caribbean on a US offset (Bahamas, Turks & Caicos, Cuba,
 * Jamaica), with every US/*, Canada/* and Mexico/* alias an old browser
 * may resolve to. The rest of the Americas (the Dominican Republic, Haiti,
 * Central and South America) is NOT here. The condition key stays
 * `tz_not_us` for the rules already stored. The zone NAME only decides:
 * the offset never does (UTC-4…-10 covers half the Americas).
 */
function eval_tz_us(string $zone): bool
{
    static $us = [
        // The 50 states + DC (and the Indianapolis alias real browsers resolve to).
        'america/new_york', 'america/detroit', 'america/kentucky/louisville', 'america/kentucky/monticello',
        'america/indiana/indianapolis', 'america/indiana/vincennes', 'america/indiana/winamac', 'america/indiana/marengo',
        'america/indiana/petersburg', 'america/indiana/vevay', 'america/indiana/knox', 'america/indiana/tell_city',
        // america/indianapolis: the pre-IANA alias (a link to america/indiana/indianapolis) is what most
        // browsers resolve to (Intl.DateTimeFormat gives the canonical name's SHORTEST alias).
        'america/indianapolis',
        'america/chicago', 'america/menominee', 'america/north_dakota/center', 'america/north_dakota/beulah',
        'america/north_dakota/new_salem', 'america/denver', 'america/boise', 'america/phoenix', 'america/los_angeles',
        'america/anchorage', 'america/juneau', 'america/metlakatla', 'america/nome', 'america/sitka', 'america/yakutat',
        'america/adak', 'pacific/honolulu',
        'us/eastern', 'us/central', 'us/mountain', 'us/pacific', 'us/arizona', 'us/alaska', 'us/hawaii',
        'us/aleutian', 'us/east-indiana', 'us/indiana-starke', 'us/michigan',
        // The US territories.
        'america/puerto_rico', 'america/st_thomas', 'america/virgin',
        'pacific/guam', 'pacific/saipan', 'pacific/pago_pago', 'pacific/samoa', 'us/samoa',
        'pacific/wake', 'pacific/midway',
        // Canada (the CA zones + the city and Canada/* aliases).
        'america/toronto', 'america/montreal', 'america/nipigon', 'america/thunder_bay',
        'america/winnipeg', 'america/rainy_river', 'america/regina', 'america/swift_current',
        'america/edmonton', 'america/yellowknife', 'america/fort_nelson', 'america/dawson_creek', 'america/creston',
        'america/vancouver', 'america/dawson', 'america/whitehorse', 'america/inuvik', 'america/cambridge_bay',
        'america/iqaluit', 'america/pangnirtung', 'america/rankin_inlet', 'america/resolute',
        'america/atikokan', 'america/coral_harbour', 'america/blanc-sablon',
        'america/halifax', 'america/glace_bay', 'america/moncton', 'america/goose_bay', 'america/st_johns',
        'canada/eastern', 'canada/central', 'canada/mountain', 'canada/pacific', 'canada/atlantic',
        'canada/newfoundland', 'canada/saskatchewan', 'canada/east-saskatchewan', 'canada/yukon',
        // Mexico (the MX zones + the Mexico/* and city aliases).
        'america/mexico_city', 'america/cancun', 'america/merida', 'america/monterrey', 'america/matamoros',
        'america/mazatlan', 'america/chihuahua', 'america/ojinaga', 'america/hermosillo', 'america/tijuana',
        'america/bahia_banderas', 'america/ensenada', 'america/santa_isabel',
        'mexico/general', 'mexico/bajanorte', 'mexico/bajasur',
        // The Caribbean on a US offset: Bahamas, Turks & Caicos, Cuba, Jamaica.
        'america/nassau', 'america/grand_turk', 'america/havana', 'cuba', 'america/jamaica', 'jamaica',
    ];
    return in_array($zone, $us, true);
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
    // Chrome's RTT estimate; 0 = it hasn't measured (an in-app WebView always says 0).
    if (isset($src['nrtt']) && (int) $src['nrtt'] > 0) $out['net_rtt'] = (int) $src['nrtt'];
    if (isset($src['tze']) && is_string($src['tze']) && $src['tze'] !== '') {
        $out['tze'] = strtolower($src['tze']);
        // tz_not_us: the zone is outside the home list (US + territories, CA, MX, nearby Caribbean).
        $out['tz_not_us'] = eval_tz_us($out['tze']) ? 0 : 1;
    }
    // The on/off detectors, derived from the raw signals.
    if (array_key_exists('mtp', $src)) $out['no_touch'] = ((int) $src['mtp'] <= 0) ? 1 : 0;
    if (array_key_exists('chr', $src)) $out['no_chrome_object'] = ((int) $src['chr'] === 1) ? 0 : 1;
    if (array_key_exists('cke', $src)) $out['no_cookie'] = ((int) $src['cke'] === 1) ? 0 : 1;
    // odd_resolution: the viewport doesn't fit the screen in either orientation.
    // iOS reports screen.width/height in portrait even with the device turned,
    // so a landscape iPad (1080x653 in a 810x1080 screen) only fits rotated.
    if (isset($src['sw'], $src['vw']) && (int) $src['sw'] > 0 && (int) $src['vw'] > 0) {
        $sw = (int) $src['sw'];
        $sh = (int) ($src['sh'] ?? 0);
        $vw = (int) $src['vw'];
        $vh = (int) ($src['vh'] ?? 0);
        $fits = ($vw <= $sw && $vh <= $sh) || ($vw <= $sh && $vh <= $sw);
        $out['odd_resolution'] = $fits ? 0 : 1;
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

/** The route is the checkpoint's interstitial page (not a funnel or safe view). */
function eval_route_is_checkpoint(?array $route): bool
{
    return $route !== null && ($route['_eval'] ?? null) === 'checkpoint';
}

/**
 * The response's one checkpoint cookie: "chk" on the interstitial page, "ok"
 * once a POST passed, none otherwise. Never two: a second dop_ev in the same
 * response replaces the first in the browser — the signals entry's key used
 * to follow "ok" and win, so nobody kept "ok", the next request (a funnel's
 * step switch) got the checkpoint again and landed back on the first step.
 */
function eval_response_cookie(?array $route): ?string
{
    if (eval_route_is_checkpoint($route)) {
        return eval_cookie('chk');
    }
    if ($route !== null && !empty($route['_eval_ok'])) {
        return eval_cookie(EVAL_COOKIE_OK);
    }
    return null;
}
