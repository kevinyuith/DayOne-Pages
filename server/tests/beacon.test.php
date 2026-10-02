<?php
declare(strict_types=1);

// Where the script goes: before the LAST </body> (case-insensitive); without </body>, at the end.
same('before </body>', '<html><body>x' . BEACON_SCRIPT . '</body></html>', beacon_inject('<html><body>x</body></html>'));
same('before the last </BODY>', '<p>"</body>"</p>' . BEACON_SCRIPT . '</BODY>', beacon_inject('<p>"</body>"</p></BODY>'));
same('no </body>: at the end', '<p>x</p>' . BEACON_SCRIPT, beacon_inject('<p>x</p>'));
check('script calls the endpoint on load', str_contains(BEACON_SCRIPT, 'sendBeacon("/_dop/l"') && str_contains(BEACON_SCRIPT, '"load"'));

// Which responses get the load notice: the gate's funnel pages (match_type GATE), HTML only.
$html = ['content_type' => 'text/html; charset=utf-8', 'match_type' => 'GATE'];
check('html at /', beacon_applies($html, make_request()));
check('the safe page (GATE-SAFE): no', !beacon_applies(['match_type' => 'GATE-SAFE'] + $html, make_request()));
check('a route without the gate: no', !beacon_applies(['match_type' => 'FALLBACK'] + $html, make_request()));
check('no match_type: no', !beacon_applies(['content_type' => 'text/html'], make_request()));
check('html at .php', beacon_applies($html, make_request(['REQUEST_URI' => '/thank-you.php'])));
check('empty content_type = html', beacon_applies(['match_type' => 'GATE', 'content_type' => ''], make_request()));
check('no content_type = html', beacon_applies(['match_type' => 'GATE'], make_request()));
check('css: no', !beacon_applies(['match_type' => 'GATE', 'content_type' => 'text/css'], make_request(['REQUEST_URI' => '/app.css'])));
check('html served as .txt: no', !beacon_applies($html, make_request(['REQUEST_URI' => '/robots.txt'])));

// Cookie and id.
check('id = 32 hex', preg_match('/^[0-9a-f]{32}$/', beacon_new_visit_id()) === 1);
check('different ids', beacon_new_visit_id() !== beacon_new_visit_id());
// ── The funnel page's id: a cookie, and {{page_id}} where the page asks for it ──
$pid = '11111111-aaaa-4aaa-8aaa-0000000000b1';
same('page_id cookie (not HttpOnly: the page script reads it)', "page_id=$pid; Path=/; Max-Age=86400; Secure; SameSite=Lax", page_id_cookie($pid));
same('page_id cookie: uppercase id is lowercased', "page_id=$pid; Path=/; Max-Age=86400; Secure; SameSite=Lax", page_id_cookie(strtoupper($pid)));
same('page_id cookie: not a uuid → none', null, page_id_cookie('p_abc'));
same('page_id cookie: empty → none', null, page_id_cookie(''));
same('page_id_value: a uuid, lowercased', $pid, page_id_value(strtoupper($pid)));
same('page_id_value: not a uuid, or not a string → null', [null, null, null], [page_id_value('p_abc'), page_id_value(null), page_id_value(42)]);
same('{{page_id}} → the id (inner spaces too)', "<script src=\"https://cdn.test/js/dot.js?origin=lander&amp;page_id=$pid\"></script><i>$pid</i>",
    page_id_placeholder_apply('<script src="https://cdn.test/js/dot.js?origin=lander&amp;page_id={{page_id}}"></script><i>{{ page_id }}</i>', $pid));
same('{{page_id}} without an id → empty', '<script src="dot.js?page_id="></script>', page_id_placeholder_apply('<script src="dot.js?page_id={{page_id}}"></script>', null));
same('no {{page_id}}: null (other placeholders are not its business)', null, page_id_placeholder_apply('<p>{{video_id}} {{domain}} {page_id}</p>', $pid));

same('cookie (not HttpOnly: the script reads the id once, at load)', 'dop_v=' . str_repeat('a', 32) . '; Path=/; Max-Age=600; Secure; SameSite=Lax', beacon_cookie(str_repeat('a', 32)));

// POST /_dop/l.
$id = str_repeat('0f', 16);
$post = static fn (string $cookie = '') => make_request(['REQUEST_METHOD' => 'POST', 'REQUEST_URI' => '/_dop/l', 'HTTP_COOKIE' => $cookie]);
[$status, $headers, $body, $visit, $notice] = handle_beacon($post("a=1; dop_v=$id"), 't=812');
same('beacon: 204', 204, $status);
same('beacon: no-store', 'no-store', $headers['Cache-Control'] ?? null);
same('beacon: no body', null, $body);
same('beacon: id from the cookie', $id, $visit);
same('beacon: a load notice with its ms', ['kind' => 'load', 'ms' => 812], $notice);
same('beacon without cookie: 204 and nothing to record', [204, null], [handle_beacon($post(), 't=1')[0], handle_beacon($post(), 't=1')[3]]);
same('beacon with invalid cookie: nothing to record', null, handle_beacon($post('dop_v=../x'), 't=1')[3]);
same('beacon with uppercase id: nothing to record', null, handle_beacon($post('dop_v=' . strtoupper($id)), 't=1')[3]);
same('beacon: absurd t becomes null', null, handle_beacon($post("dop_v=$id"), 't=99999999')[4]['ms']);
same('beacon: negative t becomes null', null, handle_beacon($post("dop_v=$id"), 't=-5')[4]['ms']);
same('beacon: no t, id still counts', [$id, ['kind' => 'load', 'ms' => null]], array_slice(handle_beacon($post("dop_v=$id"), ''), 3, 2));
same('beacon: click out', [$id, ['kind' => 'click', 'ms' => null]], array_slice(handle_beacon($post("dop_v=$id"), 'c=1'), 3, 2));
same('beacon: first interaction, its kind and ms', [$id, ['kind' => 'mouse', 'ms' => 2300]], array_slice(handle_beacon($post("dop_v=$id"), 'i=mouse&t=2300'), 3, 2));
foreach (['scroll', 'touch', 'key'] as $k) {
    same("beacon: interaction $k", $k, handle_beacon($post("dop_v=$id"), "i=$k&t=5")[4]['kind']);
}
same('beacon: unknown interaction → nothing to record (never a load with its ms)', null, handle_beacon($post("dop_v=$id"), 'i=hover&t=5')[3]);
same('beacon: interaction as an array → nothing to record', null, handle_beacon($post("dop_v=$id"), 'i[]=mouse&t=5')[3]);
check('script: reports the first interaction', str_contains(BEACON_SCRIPT, '"i="+k+"&t="') && str_contains(BEACON_SCRIPT, 'e.isTrusted'));
// The script's page id ("v", read at load) wins over the cookie (a later page may have replaced it).
$later = str_repeat('ab', 16);
same('beacon: the body\'s v wins over the cookie', $id, handle_beacon($post("dop_v=$later"), "v=$id&t=5")[3]);
same('beacon: no v → the cookie (an older script)', $later, handle_beacon($post("dop_v=$later"), 't=5')[3]);
same('beacon: a bad v → the cookie', $later, handle_beacon($post("dop_v=$later"), 'v=../x&t=5')[3]);
same('beacon: v without any cookie', $id, handle_beacon($post(), "v=$id&c=1")[3]);
// Time on the page: "d=<ms>" when the page is hidden or left.
same('beacon: duration', [$id, ['kind' => 'duration', 'ms' => 95000]], array_slice(handle_beacon($post(), "v=$id&d=95000"), 3, 2));
same('beacon: duration up to 4 h', 14400000, handle_beacon($post(), "v=$id&d=14400000")[4]['ms']);
same('beacon: duration over 4 h → nothing to record', null, handle_beacon($post(), "v=$id&d=14400001")[3]);
same('beacon: a bad duration → nothing to record', null, handle_beacon($post(), "v=$id&d=-1")[3]);
same('beacon: a huge duration → nothing to record', null, handle_beacon($post(), "v=$id&d=99999999999999999999")[3]);
check('script: reads the id once and sends it with every notice', str_contains(BEACON_SCRIPT, 'document.cookie.match(') && str_contains(BEACON_SCRIPT, '"v="+v+"&"'));
check('script: reports the time on the page when hidden or left', str_contains(BEACON_SCRIPT, '"pagehide"') && str_contains(BEACON_SCRIPT, '"visibilitychange"') && str_contains(BEACON_SCRIPT, 'b("d="'));
same('beacon via GET: 404', 404, handle_beacon(make_request(['REQUEST_URI' => '/_dop/l', 'HTTP_COOKIE' => "dop_v=$id"]), '')[0]);

// ── Device/behavior signals (sg=<json>): capabilities at load, event counts when hidden/left ──
$sgCaps = rawurlencode(json_encode(['wd' => 0, 'pl' => 'iPhone', 'mtp' => 5, 'nl' => 2, 'ptr' => 'coarse', 'mob' => 1]));
same('beacon: signals at load (the notice stays a load)', [$id, ['kind' => 'load', 'ms' => null, 'sg' => ['wd' => 0, 'pl' => 'iPhone', 'mtp' => 5, 'nl' => 2, 'ptr' => 'coarse', 'mob' => 1]]], array_slice(handle_beacon($post(), "v=$id&sg=$sgCaps"), 3, 2));
$sgCounts = rawurlencode(json_encode(['mm' => 12, 'wh' => 3, 'ts' => 0, 'ky' => 0]));
same('beacon: counts ride the duration notice', ['kind' => 'duration', 'ms' => 4200, 'sg' => ['mm' => 12, 'wh' => 3, 'ts' => 0, 'ky' => 0]], handle_beacon($post(), "v=$id&d=4200&sg=$sgCounts")[4]);
same('beacon: sg that is not json → dropped, the notice still counts', ['kind' => 'duration', 'ms' => 100], handle_beacon($post(), "v=$id&d=100&sg=not-json")[4]);
same('beacon: sg not an object → dropped', ['kind' => 'load', 'ms' => null], handle_beacon($post(), "v=$id&sg=" . rawurlencode('[1,2,3]'))[4]);
same('beacon: sg empty object → dropped', ['kind' => 'load', 'ms' => null], handle_beacon($post(), "v=$id&sg=" . rawurlencode('{}'))[4]);
same('beacon: sg oversized → dropped', ['kind' => 'load', 'ms' => null], handle_beacon($post(), "v=$id&sg=" . rawurlencode(json_encode(['pl' => str_repeat('x', 5000)])))[4]);
same('beacon: sg keys and values are sanitized', ['wd' => 1, 'pl' => 'x'], handle_beacon($post(), "v=$id&sg=" . rawurlencode(json_encode(['wd' => 1, 'pl' => 'x', 'BADKEY' => 1, 'nested' => ['a' => 1], 'long' => str_repeat('y', 61), 'num01' => 5])))[4]['sg'] ?? null);
same('beacon_parse_signals: scalar json → null', null, beacon_parse_signals('"fine"'));
same('beacon_parse_signals: keeps bools, ints, floats, short strings', ['wd' => true, 'mm' => 3, 'dpr' => 2.5, 'ptr' => 'fine'], beacon_parse_signals('{"wd":true,"mm":3,"dpr":2.5,"ptr":"fine"}'));
check('script: collects the capability signals', str_contains(BEACON_SCRIPT, 'N.webdriver') && str_contains(BEACON_SCRIPT, 'maxTouchPoints') && str_contains(BEACON_SCRIPT, 'pointer:fine') && str_contains(BEACON_SCRIPT, 'userAgentData'));
check('script: counts the session events', str_contains(BEACON_SCRIPT, 'K={mm:0,md:0,wh:0,sc:0,ts:0,ky:0,ck:0}') && str_contains(BEACON_SCRIPT, 'e.isTrusted'));
check('script: sends the signals json url-encoded', str_contains(BEACON_SCRIPT, '"sg="+encodeURIComponent(JSON.stringify('));
// Headless/automation tells and mouse trajectory (bot-vs-human).
check('script: collects automation and WebGL tells', str_contains(BEACON_SCRIPT, 'S.aut=') && str_contains(BEACON_SCRIPT, 'cdc_') && str_contains(BEACON_SCRIPT, 'WEBGL_debug_renderer_info') && str_contains(BEACON_SCRIPT, 'S.glsw='));
check('script: asks for the phone\'s model (client hint) and sends it even when it comes after the load', str_contains(BEACON_SCRIPT, 'getHighEntropyValues(["model"])') && str_contains(BEACON_SCRIPT, 'S.mdl=m') && str_contains(BEACON_SCRIPT, 'if(_sd)b(enc({mdl:m}))') && str_contains(BEACON_SCRIPT, 'b(enc(S));_sd=true'));
check('script: measures the mouse trajectory (straightness, turns, teleports)', str_contains(BEACON_SCRIPT, 'K.str=') && str_contains(BEACON_SCRIPT, 'K.dc=') && str_contains(BEACON_SCRIPT, 'K.tp='));
check('script: reports the read depth (deepest % of the page, its height) when hidden or left', str_contains(BEACON_SCRIPT, 'K.sd=_dp;K.ph=_ph') && str_contains(BEACON_SCRIPT, 'q(_se);q(null)') && str_contains(BEACON_SCRIPT, 'q(e.target)'));
same('beacon_parse_signals: keeps the read depth (sd, ph)', ['sd' => 63, 'ph' => 8240], beacon_parse_signals('{"sd":63,"ph":8240}'));
same('beacon_parse_signals: keeps the new keys (aut, gl, glsw, lng, tp, dc, str)',
    ['aut' => 2, 'gl' => 'Google SwiftShader', 'glsw' => 1, 'lng' => 'en-US', 'tp' => 0, 'dc' => 1, 'str' => 98],
    beacon_parse_signals('{"aut":2,"gl":"Google SwiftShader","glsw":1,"lng":"en-US","tp":0,"dc":1,"str":98}'));

// serve_slug: HTML gets the script and the ETag gets the version; anything that is not a page stays the same.
$bSlug = '22222222-2222-2222-2222-222222222222';
cache_put_content('bb01', '<html><body>hi</body></html>');
[$status, $headers, $body] = serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/html', 'match_type' => 'GATE'], make_request());
same('serve funnel html: body with the script (and dot.js: without steps it is all Lander)', track_inject('<html><body>hi' . BEACON_SCRIPT . '</body></html>', 'lander'), $body);
same('serve funnel html: ETag with version', '"bb01' . BEACON_ETAG . track_etag() . '"', $headers['ETag']);
same('serve funnel html: old ETag (no version) → 200', 200, serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/html', 'match_type' => 'GATE'], make_request(['HTTP_IF_NONE_MATCH' => '"bb01"']))[0]);
[$status, $headers, $body] = serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/html', 'match_type' => 'GATE-SAFE'], make_request());
same('serve the safe page: body untouched', '<html><body>hi</body></html>', $body);
same('serve the safe page: ETag is just the hash', '"bb01"', $headers['ETag']);
same('serve the safe page: an old ETag with the version → 200 (the script goes away)', 200, serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/html', 'match_type' => 'GATE-SAFE'], make_request(['HTTP_IF_NONE_MATCH' => '"bb01' . BEACON_ETAG . '"']))[0]);
[$status, $headers, $body] = serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/css'], make_request(['REQUEST_URI' => '/app.css']));
same('serve css: body untouched', '<html><body>hi</body></html>', $body);
same('serve css: ETag is just the hash', '"bb01"', $headers['ETag']);

// ── beacon_record: a notice that finds no hit yet is sent again (1, 2, 4 s) ──
$waits = [];
$sleep = static function (int $s) use (&$waits) { $waits[] = $s; };
$answers = [false, false, true];
check('found on the 3rd try', beacon_record(static function () use (&$answers) { return array_shift($answers); }, $sleep) === true);
same('waited 1 s and 2 s', [1, 2], $waits);
$waits = [];
check('never found: gives up after 4 tries', beacon_record(static fn () => false, $sleep) === false);
same('waited 1, 2 and 4 s', [1, 2, 4], $waits);
$waits = [];
$calls = 0;
check('a failed call (null) is not retried', beacon_record(static function () use (&$calls) { $calls++; return null; }, $sleep) === false && $calls === 1 && $waits === []);
check('found at once: no wait', beacon_record(static fn () => true, $sleep) === true && $waits === []);

// ── decide() end to end: only the gate's funnel page carries the notice; the safe page doesn't ──
$bDom = '99999999-0000-4000-8000-0000000000b1';
cache_put_content('bsafe1', '<html><body>SAFE PAGE</body></html>');
cache_put_content('bfun01', '<html><head><script src="dot.js"></script></head><body>FUNNEL PAGE</body></html>');
$bRoutes = [[
    'route_id' => null, 'domain_id' => $bDom, 'priority' => 0, 'match_type' => 'PAGE', 'conditions' => [], 'action' => 'SERVE',
    'page_id' => '88888888-0000-4000-8000-0000000000b1', 'slug' => '/', 'slug_id' => '44444444-0000-4000-8000-0000000000b1',
    'content_type' => 'text/html; charset=utf-8', 'content_hash' => 'bsafe1', 'preserve_query' => true,
]];
$bGate = [
    'gate_slugs' => ['/'],
    'rules' => [['name' => 'Bad UA', 'label' => 'Bot', 'tags' => [], 'conditions' => ['user_agent' => 'scraperxyz']]],
    'funnels' => ['F5' => ['split' => [['page_id' => '11111111-aaaa-4aaa-8aaa-0000000000b1', 'content_type' => 'text/html; charset=utf-8', 'content_hash' => 'bfun01', 'weight' => 100]]]],
];
[, $hd, $body, , $route] = decide($bRoutes, make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('[F5]')]), $bGate);
check('decide: the funnel page (GATE) carries the notice', str_contains((string) $body, 'FUNNEL PAGE') && str_contains((string) $body, 'data-dop-beacon') && ($route['match_type'] ?? '') === 'GATE' && beacon_applies($route, make_request()));
check('decide: the funnel page\'s ETag has the version', str_ends_with((string) $hd['ETag'], BEACON_ETAG . track_etag() . '"'), (string) $hd['ETag']);
check('decide: the funnel page\'s head is untouched (page_id goes in a cookie)', str_contains((string) $body, '<head><script src="dot.js"></script></head>') && !str_contains((string) $body, 'page_id'));
same('decide: the route carries the drawn page (app.php sets its cookie)', "page_id=11111111-aaaa-4aaa-8aaa-0000000000b1; Path=/; Max-Age=86400; Secure; SameSite=Lax", page_id_cookie((string) ($route['page_id'] ?? '')));
[, $hd, $body, , $route] = decide($bRoutes, make_request(['REQUEST_URI' => '/']), $bGate);
check('decide: the safe page (no [F…]) has no notice', str_contains((string) $body, 'SAFE PAGE') && !str_contains((string) $body, 'data-dop-beacon') && !beacon_applies($route, make_request()));
[, $hd, $body, , $route] = decide($bRoutes, make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('[F5]'), 'HTTP_USER_AGENT' => 'x scraperxyz']), $bGate);
check('decide: a click a rule caught gets the safe page, no notice', str_contains((string) $body, 'SAFE PAGE') && !str_contains((string) $body, 'data-dop-beacon') && !str_ends_with((string) $hd['ETag'], BEACON_ETAG . '"'));

// {{page_id}} in the page's own tracker tag: the funnel page the gate served; the id goes into the ETag.
cache_put_content('bfun02', '<html><head><script src="https://cdn.test/js/dot.js?origin=lander&amp;v=17&amp;page_id={{page_id}}"></script></head><body>FUNNEL {{page_id}}</body></html>');
cache_put_content('bsafe2', '<html><head><script src="https://cdn.test/js/dot.js?page_id={{page_id}}"></script></head><body>SAFE</body></html>');
$pGate = ['funnels' => ['F5' => ['split' => [['page_id' => $pid, 'content_type' => 'text/html; charset=utf-8', 'content_hash' => 'bfun02', 'weight' => 100]]]]] + $bGate;
$pRoutes = [['content_hash' => 'bsafe2'] + $bRoutes[0]];
[$st, $hd, $body] = decide($pRoutes, make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('[F5]')]), $pGate);
check('decide: {{page_id}} → the funnel page served, in the tracker tag', str_contains((string) $body, "dot.js?origin=lander&amp;v=17&amp;page_id=$pid\"") && str_contains((string) $body, "FUNNEL $pid"), (string) $body);
check('decide: the ETag has the page id', str_contains((string) $hd['ETag'], '-i' . substr($pid, 0, 8)), (string) $hd['ETag']);
same('decide: 304 with that ETag', 304, decide($pRoutes, make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('[F5]'), 'HTTP_IF_NONE_MATCH' => $hd['ETag']]), $pGate)[0]);
[, $hd, $body] = decide($pRoutes, make_request(['REQUEST_URI' => '/']), $pGate);
check('decide: the safe page gets no id ({{page_id}} empty, ETag without it)', str_contains((string) $body, 'dot.js?page_id="') && !str_contains((string) $hd['ETag'], '-i'), (string) $hd['ETag']);
// Two pages of a split with the same HTML: each response has its own id, so one's ETag never validates the other.
$pid2 = '22222222-aaaa-4aaa-8aaa-0000000000b2';
$pGate2 = ['funnels' => ['F5' => ['split' => [['page_id' => $pid2, 'content_type' => 'text/html; charset=utf-8', 'content_hash' => 'bfun02', 'weight' => 100]]]]] + $bGate;
[$st2, , $body2] = decide($pRoutes, make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('[F5]'), 'HTTP_IF_NONE_MATCH' => '"bfun02-i' . substr($pid, 0, 8) . '"']), $pGate2);
check('decide: same HTML, another page → 200 with its own id', $st2 === 200 && str_contains((string) $body2, "FUNNEL $pid2"));
