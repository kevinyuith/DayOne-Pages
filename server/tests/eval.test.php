<?php
declare(strict_types=1);

// ── The device checkpoint: the Suspicious stage of the gate, run in the browser (eval.php) ──

$domId = '99999999-0000-4000-8000-000000000099';
$pageId = '88888888-0000-4000-8000-000000000088';
$pgA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

$routeAt = fn (string $slug, string $hash): array => [
    'route_id' => null, 'domain_id' => $domId, 'priority' => 0, 'match_type' => 'PAGE',
    'conditions' => [], 'action' => 'SERVE', 'page_id' => $pageId, 'slug' => $slug,
    'slug_id' => '44444444-0000-4000-8000-0000000000aa', 'content_type' => 'text/html; charset=utf-8',
    'content_hash' => $hash, 'preserve_query' => true,
];

// A gate with the checkpoint ON (eval_rules present) and a live funnel. The
// eval rule goes after a mobile click from Taboola — a click that isn't that
// skips the checkpoint entirely (eval_checkpoint_applies).
$mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
$gate = [
    'gate_slugs' => ['/'],
    'rules' => [],
    'eval_rules' => [
        ['name' => 'Mobile no touch', 'label' => 'Suspicious', 'reason' => 'Mobile UA without a touchscreen', 'tags' => ['emu'], 'conditions' => ['sub11' => 'taboola', 'devices' => ['mobile'], 'touch' => 0]],
    ],
    'funnels' => [
        'F23' => [
            'split' => [
                ['page_id' => $pgA, 'content_type' => 'text/html; charset=utf-8', 'content_hash' => 'fade01', 'weight' => 100],
            ],
        ],
    ],
];
$click = fn (string $qs = '', array $over = []) => make_request(array_merge(['REQUEST_URI' => '/?sub1=' . rawurlencode('x[F23]') . '&sub11=taboola' . $qs, 'HTTP_USER_AGENT' => $mobileUA], $over));

cache_put_content('home01', '<html><body>HOME</body></html>');
cache_put_content('fade01', '<html><body>F23-A</body></html>');
$root = [$routeAt('/', 'home01')];

// ── A clean click the eval rule is after (sub11=taboola, mobile): the checkpoint page ──
[$st, $hd, $body, $outcome, $route] = decide($root, $click(), $gate);
same('checkpoint: served', [200, 'served', 'GATE'], [$st, $outcome, $route['match_type']]);
same('checkpoint: the _eval mark', 'checkpoint', $route['_eval'] ?? null);
check('checkpoint: the interstitial page runs the eval script', str_contains((string) $body, '<script>(function(){'));
check('checkpoint: no title (a cloaker fingerprint)', !str_contains((string) $body, '<title>'));
check('checkpoint: the script is in the head', str_contains((string) $body, '</script></head><body>'));
check('checkpoint: never cached', str_contains((string) ($hd['Cache-Control'] ?? ''), 'no-store'));
check('checkpoint: not the funnel page', !str_contains((string) $body, 'F23-A'));
same('checkpoint: decision marker', 'SERVE · GATE · EVAL', hit_decision($route));

// The script is obfuscated: nothing readable about what it measures or where
// the POST goes (no field name, no property names, no globals in the clear).
foreach (['dop_ev', 'webdriver', 'maxTouchPoints', 'cookieEnabled', 'userAgentData', 'navigator', 'matchMedia', 'createElement', 'submit', 'playwright', 'swiftshader', 'timezone', 'WEBGL',
    // The fingerprint extras (the device_fingerprint signals): nothing readable either.
    'userActivation', 'speechSynthesis', 'getVoices', 'localStorage', 'indexedDB', 'mediaDevices', 'runtime', 'outerWidth', 'mimeTypes', 'toDataURL', 'fillText', 'HeadlessChrome', 'hasBeenActive', 'voiceschanged', 'brands'] as $word) {
    check("obfuscated: no readable \"$word\"", !str_contains((string) $body, $word));
}
// It's a fixed blob (zero work per response): the same every time, and it
// matches the builder's output (a drift = someone changed the signals and
// forgot to re-run server/dev/regen-eval-script.php).
[, , $body2] = eval_checkpoint_response();
check('obfuscated: a fixed blob (same every response)', $body === $body2);
check('obfuscated: EVAL_SCRIPT matches the build', EVAL_SCRIPT === eval_checkpoint_build());

// ── The mid page only exists for a click a Suspicious rule is after ──
// Another sub11: no rule is after it — straight to the funnel, no page.
$other = make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('x[F23]') . '&sub11=facebook', 'HTTP_USER_AGENT' => $mobileUA]);
[, , $body, , $route] = decide($root, $other, $gate);
same('other sub11: skips the checkpoint, to the funnel', 'GATE', $route['match_type']);
check('other sub11: the funnel page', str_contains((string) $body, 'F23-A'));
check('other sub11: no checkpoint mark', !isset($route['_eval']));
// A desktop UA: the rule's `devices` isn't met — no checkpoint either.
$desk = make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('x[F23]') . '&sub11=taboola']);
[, , $body, , $route] = decide($root, $desk, $gate);
same('desktop UA: skips the checkpoint', 'GATE', $route['match_type']);

// A prefetch isn't a click: it skips the checkpoint and stays on the domain's page.
[$st, , $body, , $route] = decide($root, $click('', ['HTTP_SEC_PURPOSE' => 'prefetch']), $gate);
same('prefetch: the safe page', [200, 'GATE-SAFE', 'home01'], [$st, $route['match_type'], $route['content_hash']]);
same('prefetch: the _eval mark', 'prefetch', $route['_eval'] ?? null);
same('prefetch: decision marker', 'SERVE · GATE-SAFE · EVAL-PREFETCH', hit_decision($route));

// A passed checkpoint (dop_ev=ok): straight to the funnel.
$okReq = $click('', ['HTTP_COOKIE' => EVAL_COOKIE . '=' . EVAL_COOKIE_OK]);
[, , $body, , $route] = decide($root, $okReq, $gate);
same('passed: the funnel', 'GATE', $route['match_type']);
check('passed: the funnel page', str_contains((string) $body, 'F23-A'));
check('passed: no checkpoint mark', !isset($route['_eval']));

// Without eval rules the checkpoint is off: the funnel right away.
[, , $body, , $route] = decide($root, $click(), [...$gate, 'eval_rules' => []]);
same('no eval rules: the funnel', 'GATE', $route['match_type']);

// ── The browser's verdict, via the form POST body (the Adspect flow): the
// checkpoint posted the device's signals back to the same URL. A rule whose
// conditions now all match flags the click → the safe page, in the POST's
// own response.
$post = $click();
$post->evalSignals = ['mtp' => 0, 'ptr' => 'fine', 'wd' => 0]; // a desktop posing as a phone: no touch
[, , $body, , $route] = decide($root, $post, $gate);
same('verdict POST: the safe page', ['GATE-SAFE', 'home01'], [$route['match_type'], $route['content_hash']]);
same('verdict POST: the rule flags', ['Suspicious', 'Mobile no touch', ['emu']], [$route['_rule_label'], $route['_rule'], $route['_rule_tags']]);
same('verdict POST: the reason', 'Mobile UA without a touchscreen', $route['_rule_reason']);
check('verdict POST: the safe HTML', str_contains((string) $body, 'HOME'));

// A POST whose signals match NO eval rule passed the checkpoint: the funnel,
// and the route is marked to set the ok cookie.
$postOk = $click();
$postOk->evalSignals = ['mtp' => 5, 'ptr' => 'coarse', 'wd' => 0]; // a real phone: touch
[, , $body, , $route] = decide($root, $postOk, $gate);
same('passed POST: the funnel', 'GATE', $route['match_type']);
check('passed POST: the funnel page', str_contains((string) $body, 'F23-A'));
check('passed POST: marked for the ok cookie', !empty($route['_eval_ok']));
// ONE dop_ev per response: a second one (the signals entry's key) used to
// follow "ok" and replace it in the browser, so the next request got the
// checkpoint again.
same('passed POST: the one cookie is ok', EVAL_COOKIE . '=' . EVAL_COOKIE_OK . '; Path=/; Max-Age=' . EVAL_OK_TTL . '; Secure; SameSite=Lax', eval_response_cookie($route));
[, , , , $chkRoute] = decide($root, $click(), $gate);
same('checkpoint page: the chk cookie', EVAL_COOKIE . '=chk; Path=/; Max-Age=' . EVAL_SIGNALS_TTL . '; Secure; SameSite=Lax', eval_response_cookie($chkRoute));
check('checkpoint page: is the checkpoint', eval_route_is_checkpoint($chkRoute));

// ── A www. entry never sees the checkpoint ──
// The request always becomes the www → bare redirect (www_entry_redirect): a
// mid page here would only mark the visitor (chk) for a judgment that belongs
// to the bare host — every www hit logged "no js" and the click passed the
// checkpoint twice. On the www the gate pretends the checkpoint doesn't exist.
$wwwNoJs = $gate;
$wwwNoJs['eval_rules'][] = ['name' => 'Taboola no js', 'label' => 'Suspicious', 'reason' => 'No JavaScript', 'tags' => [], 'conditions' => ['sub11' => 'taboola', 'no_js' => 1]];
$wwwClick = fn (array $over = []) => $click('', array_merge(['HTTP_HOST' => 'www.example.com'], $over));
[, , $body, , $route] = decide($root, $wwwClick(), $wwwNoJs);
same('www: no checkpoint, straight to the funnel', ['GATE', 'F23'], [$route['match_type'], $route['_funnel']]);
check('www: the funnel page, not the interstitial', str_contains((string) $body, 'F23-A') && !eval_route_is_checkpoint($route));
// … even with the chk cookie from a previous visit (the old "no js" verdict).
[, , $body, , $route] = decide($root, $wwwClick(['HTTP_COOKIE' => EVAL_COOKIE . '=chk']), $wwwNoJs);
same('www + chk cookie: the funnel, no rule', ['GATE', null], [$route['match_type'], $route['_rule'] ?? null]);
check('www + chk cookie: the funnel page', str_contains((string) $body, 'F23-A'));
// The bare host with the same cookie still judges: the no_js rule flags it.
$noJsGate = [...$gate, 'eval_rules' => [$wwwNoJs['eval_rules'][1]]];
[, , $body, , $route] = decide($root, $click('', ['HTTP_COOKIE' => EVAL_COOKIE . '=chk']), $noJsGate);
same('bare + chk cookie: the no_js rule flags', ['GATE-SAFE', 'Taboola no js', 'home01'], [$route['match_type'], $route['_rule'], $route['content_hash']]);
// The www redirect takes over the served funnel route (app.php's part).
$wwwRoute = www_entry_redirect($wwwClick(), 'served', $route);
same('www: the redirect happens after', 302, $wwwRoute[0] ?? null);

// A funnel's step switch that meets the checkpoint: the POST (same URL, the
// dop_step cookie kept by the checkpoint page) serves the step asked for,
// not the first one again.
$stepGate = $gate;
$stepGate['funnels']['F23']['split'][0]['content_hash'] = '5ce901';
cache_put_content('5ce901', '<html><body><section data-dop-page="p_pre" data-dop-name="Pre Lander" data-dop-kind="presell" data-dop-start>PRE</section><section data-dop-page="p_vsl" data-dop-name="Lander" data-dop-kind="main" hidden>VSL</section></body></html>');
[, , $body, , $route] = decide($root, $click('', ['HTTP_COOKIE' => 'dop_step=p_vsl']), $stepGate);
check('step switch: the checkpoint page', eval_route_is_checkpoint($route) && !str_contains((string) $body, 'PRE'));
$stepPost = $click('', ['HTTP_COOKIE' => 'dop_step=p_vsl; ' . EVAL_COOKIE . '=chk']);
$stepPost->evalSignals = ['mtp' => 5, 'ptr' => 'coarse', 'wd' => 0];
[, , $body, , $route] = decide($root, $stepPost, $stepGate);
check('step switch POST: the Lander, not the Pre Lander', str_contains((string) $body, 'VSL') && !str_contains((string) $body, 'PRE'));
check('step switch POST: marked ok', !empty($route['_eval_ok']));

// ── Bot rules walk before Suspicious ones (position doesn't matter) ──
$walkGate = [...$gate, 'eval_rules' => [], 'rules' => [
    ['name' => 'A suspicious', 'label' => 'Suspicious', 'reason' => '', 'tags' => [], 'conditions' => ['devices' => ['mobile']]],
    ['name' => 'A bot', 'label' => 'Bot', 'reason' => '', 'tags' => [], 'conditions' => ['devices' => ['mobile', 'desktop']]],
]];
[, , , , $route] = decide($root, make_request(['REQUEST_URI' => '/?sub1=x[F23]', 'HTTP_USER_AGENT' => $mobileUA]), $walkGate);
same('walk: Bot before Suspicious', ['Bot', 'A bot'], [$route['_rule_label'], $route['_rule']]);
// Only the Suspicious one matches (a desktop UA: the Bot rule wants mobile or desktop…
// make it want mobile only so the desktop click leaves it out).
$walkGate2 = [...$gate, 'eval_rules' => [], 'rules' => [
    ['name' => 'A suspicious', 'label' => 'Suspicious', 'reason' => '', 'tags' => [], 'conditions' => ['devices' => ['mobile', 'desktop']]],
    ['name' => 'A bot', 'label' => 'Bot', 'reason' => '', 'tags' => [], 'conditions' => ['devices' => ['mobile']]],
]];
[, , , , $route] = decide($root, make_request(['REQUEST_URI' => '/?sub1=x[F23]']), $walkGate2);
same('walk: the Suspicious one alone still flags', ['Suspicious', 'A suspicious'], [$route['_rule_label'] ?? null, $route['_rule'] ?? null]);

// ── eval_cookie "absent": a click that never passed the checkpoint ──
$absentReq = make_request([]);
$absentReq->evalParams = [];
same('eval_cookie absent: no cookie matches', true, eval_conditions_match(['eval_cookie' => 'absent'], $absentReq, null, null));
$withOk = make_request(['HTTP_COOKIE' => EVAL_COOKIE . '=' . EVAL_COOKIE_OK]);
$withOk->evalParams = [];
same('eval_cookie absent: passed cookie fails', false, eval_conditions_match(['eval_cookie' => 'absent'], $withOk, null, null));
$withChk = make_request(['HTTP_COOKIE' => EVAL_COOKIE . '=chk']);
$withChk->evalParams = [];
same('eval_cookie absent: any checkpoint cookie fails', false, eval_conditions_match(['eval_cookie' => 'absent'], $withChk, null, null));

// ── eval_conditions_match: sub ids, URL parameters and the signals ──
$req = make_request([]);
$req->evalParams = ['sub11' => 'Taboola'];
check('sub id: exact, case-insensitive', eval_conditions_match(['sub11' => 'taboola'], $req, null, null));
check('sub id: a different value fails', !eval_conditions_match(['sub11' => 'facebook'], $req, null, null));

// A signal condition that's undecidable: no signals, no stored entry → no match (never confirms a bot).
check('touch: undecidable is no match', !eval_conditions_match(['touch' => 0], $req, null, null));
// …but the rule stays pending (the checkpoint's applies-check).
check('touch: undecidable stays pending', eval_conditions_match(['touch' => 0], $req, [], null, true));

// The POST's fresh signals (the beacon's "sg" keys).
check('touch 0: mtp=0 matches', eval_conditions_match(['touch' => 0], $req, ['mtp' => 0], null));
check('touch 0: mtp=5 fails', !eval_conditions_match(['touch' => 0], $req, ['mtp' => 5], null));
check('pointer: ptr coarse matches', eval_conditions_match(['pointer' => 'coarse'], $req, ['ptr' => 'coarse'], null));
check('pointer: ptr fine fails', !eval_conditions_match(['pointer' => 'coarse'], $req, ['ptr' => 'fine'], null));
check('webdriver: wd=1 matches', eval_conditions_match(['webdriver' => 1], $req, ['wd' => 1], null));
check('automation: aut>0 maps to 1', eval_conditions_match(['automation' => 1], $req, ['aut' => 3], null));
check('platform: upf contained, case-insensitive', eval_conditions_match(['platform' => 'android'], $req, ['upf' => 'Android'], null));

// ── The on/off bot tells (derived from the signals) ──
// Mobile + sem touch: mtp=0 fires no_touch.
check('no_touch: mtp=0 fires', eval_conditions_match(['no_touch' => 1], $req, ['mtp' => 0], null));
check('no_touch: mtp=5 does not', !eval_conditions_match(['no_touch' => 1], $req, ['mtp' => 5], null));
// Chrome UA + sem window.chrome: chr=0 fires no_chrome_object; chrome_ua reads the UA.
$chromeReq = make_request(['HTTP_USER_AGENT' => 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36']);
$chromeReq->evalParams = [];
check('chrome_ua: a Chrome UA', eval_conditions_match(['chrome_ua' => 1], $chromeReq, [], null));
$ffReq = make_request(['HTTP_USER_AGENT' => 'Mozilla/5.0 (Windows NT 10.0; rv:121.0) Gecko/20100101 Firefox/121.0']);
$ffReq->evalParams = [];
check('chrome_ua: not a Chrome UA', !eval_conditions_match(['chrome_ua' => 1], $ffReq, [], null));
check('no_chrome_object: chr=0 fires', eval_conditions_match(['no_chrome_object' => 1], $chromeReq, ['chr' => 0], null));
check('chrome UA + no window.chrome together', eval_conditions_match(['chrome_ua' => 1, 'no_chrome_object' => 1], $chromeReq, ['chr' => 0], null));
check('no_chrome_object: chr=1 does not fire', !eval_conditions_match(['no_chrome_object' => 1], $chromeReq, ['chr' => 1], null));
// Timezone incongruence: BR IP but a non-Brazil zone/offset.
$brReq = new Request(method: 'POST', rawHost: 'example.com', rawPath: '/', rawQuery: '', userAgent: 'x', referer: '', country: 'BR', acceptLanguage: '', ip: '1.2.3.4', ifNoneMatch: null, purgeToken: null, viaCloudflare: true, cookies: []);
$brReq->evalParams = [];
check('tz_mismatch: BR + UTC zone name fires', eval_conditions_match(['tz_mismatch' => 1], $brReq, ['tze' => 'UTC'], null));
check('tz_mismatch: BR + São Paulo does not', !eval_conditions_match(['tz_mismatch' => 1], $brReq, ['tze' => 'America/Sao_Paulo'], null));
check('tz_mismatch: BR + offset 0 (UTC) fires', eval_conditions_match(['tz_mismatch' => 1], $brReq, ['tz' => 0], null));
check('tz_mismatch: BR + offset 180 does not', !eval_conditions_match(['tz_mismatch' => 1], $brReq, ['tz' => 180], null));
$usReq = new Request(method: 'POST', rawHost: 'example.com', rawPath: '/', rawQuery: '', userAgent: 'x', referer: '', country: 'US', acceptLanguage: '', ip: '1.2.3.4', ifNoneMatch: null, purgeToken: null, viaCloudflare: true, cookies: []);
$usReq->evalParams = [];
check('tz_mismatch: unlisted country never fires', !eval_conditions_match(['tz_mismatch' => 1], $usReq, ['tze' => 'UTC'], null));
// Non-US timezone: the browser's zone outside the home list fires tz_not_us
// (US + territories, Canada, Mexico and the nearby Caribbean), whatever the
// IP's country is.
check('tz_not_us: New York does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/New_York'], null));
check('tz_not_us: Honolulu does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'Pacific/Honolulu'], null));
check('tz_not_us: an Indiana zone does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Indiana/Knox'], null));
check('tz_not_us: the Indianapolis alias does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Indianapolis'], null));
check('tz_not_us: a US/* alias does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'US/Eastern'], null));
check('tz_not_us: Puerto Rico does not fire (a US territory)', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Puerto_Rico'], null));
check('tz_not_us: Guam does not fire (a US territory)', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'Pacific/Guam'], null));
check('tz_not_us: St Thomas does not fire (a US territory)', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/St_Thomas'], null));
check('tz_not_us: Canada does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Toronto'], null));
check('tz_not_us: a Canada/* alias does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'Canada/Eastern'], null));
check('tz_not_us: Regina (no DST) does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Regina'], null));
check('tz_not_us: Mexico City does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Mexico_City'], null));
check('tz_not_us: Tijuana does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Tijuana'], null));
check('tz_not_us: Nassau does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Nassau'], null));
check('tz_not_us: Grand Turk does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Grand_Turk'], null));
check('tz_not_us: Havana does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Havana'], null));
check('tz_not_us: Jamaica does not fire', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Jamaica'], null));
check('tz_not_us: São Paulo fires (a US IP does not matter)', eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Sao_Paulo'], null));
check('tz_not_us: UTC fires', eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'UTC'], null));
check('tz_not_us: Lisbon fires', eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'Europe/Lisbon'], null));
check('tz_not_us: Santo Domingo fires (the Caribbean beyond the list)', eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Santo_Domingo'], null));
check('tz_not_us: Panama fires (Central America is not in the list)', eval_conditions_match(['tz_not_us' => 1], $usReq, ['tze' => 'America/Panama'], null));
check('tz_not_us: 0 matches a US zone', eval_conditions_match(['tz_not_us' => 0], $usReq, ['tze' => 'America/Chicago'], null));
check('tz_not_us: 0 does not match a non-US zone', !eval_conditions_match(['tz_not_us' => 0], $usReq, ['tze' => 'America/Sao_Paulo'], null));
// The offset never decides (UTC-4…-10 covers half the Americas): without the
// zone NAME the tell is undecidable — no match, but the rule stays pending.
check('tz_not_us: offset alone is undecidable', !eval_conditions_match(['tz_not_us' => 1], $usReq, ['tz' => 300], null));
check('tz_not_us: unknown stays pending for the checkpoint', eval_conditions_match(['tz_not_us' => 1], $usReq, [], null, true));
same('tz_not_us: the zone list helper', [true, true, true, true, false, false], [eval_tz_us('america/new_york'), eval_tz_us('us/pacific'), eval_tz_us('america/toronto'), eval_tz_us('america/nassau'), eval_tz_us('europe/madrid'), eval_tz_us('america/argentina/buenos_aires')]);
// Cookies disabled: cke=0 fires no_cookie.
check('no_cookie: cke=0 fires', eval_conditions_match(['no_cookie' => 1], $req, ['cke' => 0], null));
check('no_cookie: cke=1 does not', !eval_conditions_match(['no_cookie' => 1], $req, ['cke' => 1], null));
// Odd resolution: the viewport bigger than the screen.
check('odd_resolution: vw>sw fires', eval_conditions_match(['odd_resolution' => 1], $req, ['sw' => 360, 'sh' => 800, 'vw' => 1200, 'vh' => 700], null));
check('odd_resolution: a normal viewport does not', !eval_conditions_match(['odd_resolution' => 1], $req, ['sw' => 390, 'sh' => 844, 'vw' => 390, 'vh' => 700], null));
check('odd_resolution: a landscape iPad (screen reported in portrait) does not', !eval_conditions_match(['odd_resolution' => 1], $req, ['sw' => 810, 'sh' => 1080, 'vw' => 1080, 'vh' => 653], null));
check('odd_resolution: a landscape iPad 9.7" does not', !eval_conditions_match(['odd_resolution' => 1], $req, ['sw' => 768, 'sh' => 1024, 'vw' => 1024, 'vh' => 665], null));
check('odd_resolution: a window that fits neither orientation fires', eval_conditions_match(['odd_resolution' => 1], $req, ['sw' => 390, 'sh' => 844, 'vw' => 800, 'vh' => 600], null));
check('odd_resolution: a zoomed-out desktop (wider than the screen) still fires', eval_conditions_match(['odd_resolution' => 1], $req, ['sw' => 1280, 'sh' => 800, 'vw' => 1310, 'vh' => 575], null));
// no_js is never decided by signals (the GET-side walk handles it).
check('no_js: not a signal condition', !eval_conditions_match(['no_js' => 1], $req, ['mtp' => 0], null));

// The stored signals (a previous checkpoint's cache entry), mapped to the condition keys.
$stored = ['mtp' => 5, 'ptr' => 'coarse', 'wd' => 0, 'aut' => 0, 'glsw' => 0, 'upf' => 'Android'];
check('stored: touch from mtp', eval_conditions_match(['touch' => 1], $req, null, $stored));
check('stored: pointer from ptr', eval_conditions_match(['pointer' => 'coarse'], $req, null, $stored));
check('stored: platform from upf', eval_conditions_match(['platform' => 'android'], $req, null, $stored));
check('stored: webdriver 0 matches', eval_conditions_match(['webdriver' => 0], $req, null, $stored));
check('stored: missing key is undecidable', !eval_conditions_match(['mobile_hint' => 1], $req, null, $stored));

// The example from the spec: sub11=Taboola + mobile + no touchscreen.
$specReq = make_request(['HTTP_USER_AGENT' => $mobileUA]);
$specReq->evalParams = ['sub11' => 'Taboola'];
$specCond = ['sub11' => 'taboola', 'devices' => ['mobile'], 'touch' => 0];
check('spec: sub11+mobile+no touch matches', eval_conditions_match($specCond, $specReq, ['mtp' => 0], null));
check('spec: with a touchscreen it fails', !eval_conditions_match($specCond, $specReq, ['mtp' => 5], null));
$specOther = make_request(['HTTP_USER_AGENT' => $mobileUA]);
$specOther->evalParams = ['sub11' => 'facebook'];
check('spec: another sub11 fails', !eval_conditions_match($specCond, $specOther, ['mtp' => 0], null));

// ── The eval POST payload: parsed from the form body, query → evalParams ──
$payloadReq = make_request(['REQUEST_METHOD' => 'POST', 'REQUEST_URI' => '/?sub1=x[F23]&sub11=taboola']);
$parsed = eval_post_payload($payloadReq, EVAL_FIELD . '=' . rawurlencode(json_encode(['sg' => ['mtp' => 0, 'ptr' => 'fine']])));
assert(is_array($parsed));
[$preq, $psig] = $parsed;
same('payload: evalParams from the query', 'taboola', $preq->evalParams['sub11'] ?? null);
same('payload: the signals', ['mtp' => 0, 'ptr' => 'fine'], $psig);
same('payload: no field → null', null, eval_post_payload($payloadReq, 'other=1'));
same('payload: bad json → null', null, eval_post_payload($payloadReq, EVAL_FIELD . '=not-json'));
// The obfuscated script posts the field with a random suffix: any dop_ev* name is read.
$suffixed = eval_post_payload($payloadReq, EVAL_FIELD . 'a9f3c1=' . rawurlencode(json_encode(['sg' => ['mtp' => 5]])));
assert(is_array($suffixed));
same('payload: a suffixed field name parses', ['mtp' => 5], $suffixed[1]);

// ── The device fingerprint: the same signals, structured for pages.hits.device_fingerprint ──
$fp = eval_device_fingerprint([
    'uab' => 'Chromium,Google Chrome', 'mob' => 0, 'upf' => 'macOS',
    'hc' => 18, 'dm' => 32, 'mtp' => 0, 'ptr' => 'fine', 'dpr' => 2,
    'sw' => 1800, 'sh' => 1169, 'vw' => 1793, 'vh' => 930, 'ow' => 1793, 'oh' => 1051,
    'tze' => 'America/Sao_Paulo', 'tz' => 180, 'lngs' => 'pt-BR,pt,en-US', 'lng' => 'pt-BR',
    'crt' => 1, 'mt' => 2, 'np' => 5, 'vc' => 'pt-BR,en-US', 'cke' => 1, 'stok' => 1,
    'wd' => 0, 'wdg' => 1, 'aut' => 0, 'hua' => 0, 'chr' => 1, 'cdp' => 0, 'ifr' => 0, 'tst' => 0, 'ppo' => 0, 'uact' => 1,
    'osm' => 1, 'cvr' => 152, 'cnv' => 1, 'envok' => 1, 'mapi' => 1, 'gl' => 'ANGLE Apple', 'glsw' => 0,
]);
check('fingerprint: versioned', ($fp['v'] ?? null) === 1);
same('fingerprint: touch not capable', 0, $fp['hw']['touch_capable'] ?? null);
same('fingerprint: touch points', 0, $fp['hw']['touch_points'] ?? null);
same('fingerprint: screen', '1800x1169', $fp['hw']['screen'] ?? null);
same('fingerprint: viewport', '1793x930', $fp['hw']['viewport'] ?? null);
same('fingerprint: outer', '1793x1051', $fp['hw']['outer'] ?? null);
same('fingerprint: timezone', 'America/Sao_Paulo', $fp['env']['tz'] ?? null);
same('fingerprint: langs', 'pt-BR,pt,en-US', $fp['env']['langs'] ?? null);
same('fingerprint: voices', 'pt-BR,en-US', $fp['env']['voices'] ?? null);
same('fingerprint: wd_getter native', 'native', $fp['bot']['wd_getter'] ?? null);
same('fingerprint: uact ok', 1, $fp['bot']['uact_ok'] ?? null);
same('fingerprint: os match', 1, $fp['consist']['os_match'] ?? null);
same('fingerprint: canvas 2x consistent', 1, $fp['consist']['canvas_2x'] ?? null);
same('fingerprint: storage ok', 1, $fp['env']['storage_ok'] ?? null);
// touch_vs_dev: a mobile UA with no touch is inconsistent (0).
$fpMob = eval_device_fingerprint(['mob' => 1, 'mtp' => 0]);
same('fingerprint: mobile UA + no touch = inconsistent', 0, $fpMob['consist']['touch_vs_dev'] ?? null);
$fpMobOk = eval_device_fingerprint(['mob' => 1, 'mtp' => 5]);
same('fingerprint: mobile UA + touch = consistent', 1, $fpMobOk['consist']['touch_vs_dev'] ?? null);
$fpMobOk2 = eval_device_fingerprint(['mob' => 0, 'mtp' => 5]);
same('fingerprint: touch capable', 1, $fpMobOk2['hw']['touch_capable'] ?? null);
// os_match 2 (undecidable) is dropped.
$fpOs = eval_device_fingerprint(['osm' => 2]);
check('fingerprint: undecidable os_match dropped', !isset($fpOs['consist']['os_match']));
// wd_getter spoofed.
$fpWd = eval_device_fingerprint(['wdg' => 0]);
same('fingerprint: wd_getter spoofed', 'spoofed', $fpWd['bot']['wd_getter'] ?? null);
// Unknown signals don't appear (unknown ≠ empty), and an empty set is no fingerprint.
check('fingerprint: missing keys absent', !isset($fp['hw']['color_depth']) && !isset($fp['env']['conn']));
same('fingerprint: empty signals → null', null, eval_device_fingerprint([]));
// The payload returns it as the third element.
$parsedFp = eval_post_payload($payloadReq, EVAL_FIELD . '=' . rawurlencode(json_encode(['sg' => ['mtp' => 0, 'mob' => 1]])));
assert(is_array($parsedFp));
same('payload: the fingerprint', 0, $parsedFp[2]['consist']['touch_vs_dev'] ?? null);

// ── eval_rules_matched: the rules whose conditions all match, in order ──
$mrules = [
    ['name' => 'No touch', 'label' => 'Suspicious', 'reason' => '', 'tags' => [], 'conditions' => ['touch' => 0]],
    ['name' => 'Webdriver', 'label' => 'Suspicious', 'reason' => '', 'tags' => [], 'conditions' => ['webdriver' => 1]],
];
$mreq = make_request([]);
$mreq->evalParams = [];
same('matched: touch=0 matches', ['No touch'], array_map(fn ($r) => $r['name'], eval_rules_matched($mrules, $mreq, ['mtp' => 0], null)));
same('matched: touch+wd match both, in order', ['No touch', 'Webdriver'], array_map(fn ($r) => $r['name'], eval_rules_matched($mrules, $mreq, ['mtp' => 0, 'wd' => 1], null)));
same('matched: touch=1 matches none', [], eval_rules_matched($mrules, $mreq, ['mtp' => 5], null));
