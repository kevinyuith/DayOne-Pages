<?php
declare(strict_types=1);

// A vendor page's upsell funnel (upsell.php): the step, the group by front, the flow by rule,
// the upsell page / offer / downsells by weight (the same for the same visitor), the routing
// (internal: the vendor page needs no slug at the step's path), and the response.

$vp = '11111111-1111-4111-8111-111111111111';
$funnelId = '22222222-2222-4222-8222-222222222222';
// The upsell pages (VENDOR + kind UPSELL) the versions name.
$pUp1 = '33333333-3333-4333-8333-000000000001';
$pUp1b = '33333333-3333-4333-8333-000000000002';
$pUp1new = '33333333-3333-4333-8333-000000000003';
$pUp1c = '33333333-3333-4333-8333-000000000004';
$uv = str_repeat('a', 32);
$gate = ['upsell' => [$vp => [
    'id' => $funnelId,
    'front_param' => 'front',
    'flows' => [
        ['id' => 'f1', 'name' => 'VSL flow 1', 'when' => ['cookies' => ['vsl_ok' => 'present'], 'query' => ['sub11' => ['equals' => 'facebook']]]],
        ['id' => 'f2', 'name' => 'VSL flow 2', 'when' => ['cookies' => ['vsl_ok' => 'present'], 'countries' => ['US']]],
    ],
    'steps' => [
        ['id' => 'up1', 'slug' => '/up1', 'groups' => [
            ['id' => 'g23', 'name' => 'Came with 2 or 3', 'fronts' => ['2', '3'],
             'pages' => ['f1' => [['page_id' => $pUp1, 'weight' => 100]], 'default' => [['page_id' => $pUp1b, 'weight' => 100]]],
             'offers' => [['offer' => 'up1v2', 'weight' => 100]],
             'downsells' => [[['offer' => 'dw1_6', 'weight' => 100]]]],
            ['id' => 'g6', 'name' => 'Came with 6', 'fronts' => ['6'],
             'pages' => ['f1' => [['page_id' => $pUp1, 'weight' => 50], ['page_id' => $pUp1new, 'weight' => 50]], 'f2' => [['page_id' => $pUp1c, 'weight' => 100]], 'default' => [['page_id' => $pUp1b, 'weight' => 100]]],
             'vsls' => [['id' => '6ab68caebe6066e07d2eeadb', 'weight' => 100]],
             'offers' => [['offer' => 'up1', 'weight' => 70], ['offer' => 'up1_low', 'weight' => 30]],
             'downsells' => [[['offer' => 'dw1', 'weight' => 100]], [['offer' => 'dw2', 'weight' => 100]]]],
            ['id' => 'gany', 'name' => 'Any other', 'fronts' => [], 'pages' => ['default' => [['page_id' => $pUp1b, 'weight' => 100]]]],
        ]],
        ['id' => 'up2', 'slug' => '/up2', 'groups' => [
            ['id' => 'gall', 'name' => 'All buyers', 'fronts' => [], 'pages' => ['default' => []], 'offers' => [['offer' => 'up2', 'weight' => 100]]],
        ]],
        ['id' => 'ty', 'slug' => '/thank-you'],
    ],
    'pages' => [
        $pUp1 => ['slug' => '/', 'hash' => 'h-up1', 'type' => 'text/html; charset=utf-8'],
        $pUp1b => ['slug' => '/', 'hash' => 'h-up1b', 'type' => 'text/html; charset=utf-8'],
        $pUp1new => ['slug' => '/', 'hash' => 'h-up1new', 'type' => 'text/html; charset=utf-8'],
        $pUp1c => ['slug' => '/', 'hash' => 'h-up1c', 'type' => 'text/html; charset=utf-8'],
    ],
]]];
$placeholders = ['domain' => 'shop.example', 'checkout.up1' => 'VKWHeu02', 'checkout.up1_low' => 'LOW00001', 'checkout.up1v2' => 'V2CODE01',
                 'checkout.dw1' => 'DW1CODE1', 'checkout.dw1_6' => 'DW16CODE', 'checkout.dw2' => 'DW2CODE1', 'checkout.up2' => 'UP2CODE1'];
// The vendor page's route at a path: match_routes gives one even when the page has no such slug (slug_id null).
$route = static fn(string $slug, bool $has = false): array => [
    'action' => 'SERVE', 'domain_id' => 'd', 'page_id' => $vp, 'slug' => $slug, 'slug_id' => $has ? 'sid-' . $slug : null,
    'content_hash' => $has ? 'h-own' . str_replace('/', '-', $slug) : null, 'content_type' => $has ? 'text/html; charset=utf-8' : null,
    'placeholders' => $placeholders,
];
$up1 = $route('/up1');

// The step: the vendor page's funnel step with this path; another page or path is not one.
same('step: /up1 of the vendor page', 'up1', upsell_step($up1, $gate, '/up1')[1]['id'] ?? null);
same('step: case-insensitive path', 'up1', upsell_step($up1, $gate, '/UP1')[1]['id'] ?? null);
same('step: thank you', 'ty', upsell_step($route('/thank-you'), $gate, '/thank-you')[1]['id'] ?? null);
same('step: a path that is no step', null, upsell_step($up1, $gate, '/vip'));
same('step: another page', null, upsell_step(['page_id' => 'other'] + $up1, $gate, '/up1'));
same('step: no upsell in the gate', null, upsell_step($up1, ['funnels' => []], '/up1'));

// The group by what the buyer bought.
$step = $gate['upsell'][$vp]['steps'][0];
same('group: came with 6', 'g6', upsell_group($step, '6')['id']);
same('group: came with 3', 'g23', upsell_group($step, '3')['id']);
same('group: an unknown front → the one with no fronts', 'gany', upsell_group($step, '12')['id']);
same('group: no front → the one with no fronts', 'gany', upsell_group($step, '')['id']);
same('group: no catch-all → the first', 'g23', upsell_group(['groups' => array_slice($step['groups'], 0, 2)], '9')['id']);

// The flow: the first whose rule matches; none → default.
$funnel = $gate['upsell'][$vp];
same('flow 1: cookie + sub11=facebook', 'f1', upsell_flow($funnel, make_request(['REQUEST_URI' => '/up1?sub11=facebook', 'HTTP_COOKIE' => 'vsl_ok=1'])));
same('flow 2: cookie + US (no facebook)', 'f2', upsell_flow($funnel, make_request(['REQUEST_URI' => '/up1', 'HTTP_COOKIE' => 'vsl_ok=1', 'HTTP_CF_IPCOUNTRY' => 'US'])));
same('flow: in order, flow 1 first even when 2 matches too', 'f1', upsell_flow($funnel, make_request(['REQUEST_URI' => '/up1?sub11=facebook', 'HTTP_COOKIE' => 'vsl_ok=1', 'HTTP_CF_IPCOUNTRY' => 'US'])));
same('flow: no cookie → default', 'default', upsell_flow($funnel, make_request(['REQUEST_URI' => '/up1?sub11=facebook', 'HTTP_CF_IPCOUNTRY' => 'US'])));
check('cookies: absent', upsell_cookies_match(['x' => 'absent'], []));
check('cookies: equals', upsell_cookies_match(['x' => ['equals' => 'ok']], ['x' => 'ok']) && !upsell_cookies_match(['x' => ['equals' => 'ok']], ['x' => 'no']));
check('cookies: empty', upsell_cookies_match(['x' => 'empty'], ['x' => '']) && upsell_cookies_match(['x' => 'empty'], []));

// The weighted pick: the same seed, the same pick; the shares hold; 0 = paused.
$items = [['k' => 'a', 'weight' => 70], ['k' => 'b', 'weight' => 30], ['k' => 'c', 'weight' => 0]];
same('pick: same seed, same item', upsell_weighted($items, 'seed-1'), upsell_weighted($items, 'seed-1'));
$count = ['a' => 0, 'b' => 0, 'c' => 0];
for ($i = 0; $i < 4000; $i++) {
    $count[upsell_weighted($items, 'v' . $i)['k']]++;
}
check('pick: 70/30 within 3 points', abs($count['a'] / 4000 - 0.7) < 0.03, json_encode($count));
same('pick: weight 0 never', 0, $count['c']);
same('pick: all paused → the first', 'a', upsell_weighted([['k' => 'a', 'weight' => 0], ['k' => 'b', 'weight' => 0]], 'x')['k']);
same('pick: nothing', null, upsell_weighted([], 'x'));

// The routes: came with 6, flow 1 → an upsell page of flow 1 at /up1 (the vendor page has no /up1),
// first in the list; the offer and downsells filled, the VSL, the hit.
$other = ['action' => 'SERVE', 'domain_id' => 'd', 'page_id' => '44444444-4444-4444-8444-444444444444', 'slug' => '/up1', 'slug_id' => null, 'content_hash' => null];
$req6 = make_request(['REQUEST_URI' => '/up1?front=6&sub11=facebook', 'HTTP_COOKIE' => 'vsl_ok=1; dop_uv=' . $uv]);
[$routes6, $cookie6] = upsell_routes([$other, $up1], $gate, $req6);
$r6 = $routes6[0];
same('routes: the upsell route goes first', 2, count($routes6));
same('routes: a visitor with dop_uv gets no new cookie', null, $cookie6);
check('routes: an upsell page of flow 1', in_array($r6['page_id'], [$pUp1, $pUp1new], true), $r6['page_id']);
same('routes: its hash and type', [$gate['upsell'][$vp]['pages'][$r6['page_id']]['hash'], 'text/html; charset=utf-8'], [$r6['content_hash'], $r6['content_type']]);
same('routes: the requested path stays the slug', '/up1', $r6['slug']);
check('routes: a slug id (the gate serves it)', is_string($r6['slug_id']) && $r6['slug_id'] !== '');
same('routes: the gate\'s domain page at /up1 is it', $r6['page_id'], gate_domain_page($routes6)['page_id'] ?? null);
check('routes: offer = the checkout value of the picked key', in_array($r6['placeholders']['upsell.offer'], ['VKWHeu02', 'LOW00001'], true));
same('routes: downsell 1 and 2', ['DW1CODE1', 'DW2CODE1'], [$r6['placeholders']['upsell.downsell1'], $r6['placeholders']['upsell.downsell2']]);
same('routes: the group\'s VSL goes to the draw', '6ab68caebe6066e07d2eeadb', $r6['vsl'][0]['id'] ?? null);
same('routes: the hit (p = the upsell page)', ['f' => $funnelId, 's' => 'up1', 'g' => 'g6', 'fl' => 'f1', 'p' => $r6['page_id']], array_intersect_key($r6['_upsell']['hit'], array_flip(['f', 's', 'g', 'fl', 'p'])));
same('routes: the tracker origin', 'vendor_up1', $r6['_upsell']['origin']);
same('routes: the same visitor, the same picks', $routes6, upsell_routes([$other, $up1], $gate, $req6)[0]);

// Came with 2, no cookie → the default page (the basic one) and the 2–3 offer; a new visitor gets dop_uv.
[$routes2, $cookie2] = upsell_routes([$up1], $gate, make_request(['REQUEST_URI' => '/up1?front=2']));
same('routes: default flow → the basic page', $pUp1b, $routes2[0]['page_id']);
same('routes: its hash', 'h-up1b', $routes2[0]['content_hash']);
same('routes: the 2–3 offer', 'V2CODE01', $routes2[0]['placeholders']['upsell.offer']);
same('routes: no VSL in the group → no draw', null, $routes2[0]['vsl'] ?? null);
check('routes: a new visitor gets dop_uv', is_string($cookie2) && preg_match('/^dop_uv=[0-9a-f]{32}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/', $cookie2) === 1, (string) $cookie2);

// An upsell page the gate doesn't carry (archived, another product…) is never served: flow 2's only
// version is gone → nothing to serve at /up1 (the vendor page has no /up1) → unchanged, 404.
$gateNoC = $gate;
unset($gateNoC['upsell'][$vp]['pages'][$pUp1c]);
$reqF2 = make_request(['REQUEST_URI' => '/up1?front=6', 'HTTP_COOKIE' => 'vsl_ok=1', 'HTTP_CF_IPCOUNTRY' => 'US']);
same('routes: unknown version, no slug of its own → unchanged', [[$up1], null], upsell_routes([$up1], $gateNoC, $reqF2));
// …but when the vendor page has its own /up1, that one is served, marked as the step.
[$routesOwn] = upsell_routes([$route('/up1', true)], $gateNoC, $reqF2);
same('routes: unknown version, the vendor page\'s own slug', [$vp, 'h-own-up1', '/up1'], [$routesOwn[0]['page_id'], $routesOwn[0]['content_hash'], $routesOwn[0]['_upsell']['hit']['p']]);

// A step with no version: the vendor page's own slug if it has one, else unchanged.
same('routes: up2 without versions, no slug → unchanged', [[$route('/up2')], null], upsell_routes([$route('/up2')], $gate, make_request(['REQUEST_URI' => '/up2'])));
[$routesUp2] = upsell_routes([$route('/up2', true)], $gate, make_request(['REQUEST_URI' => '/up2']));
same('routes: up2 with its own slug → the offer filled', 'UP2CODE1', $routesUp2[0]['placeholders']['upsell.offer']);

// The Thank you page: the vendor page's own slug, the tracker and the hit.
[$routesTy, $cty] = upsell_routes([$route('/thank-you', true)], $gate, make_request(['REQUEST_URI' => '/thank-you']));
same('thank you: origin', 'vendor_thank_you', $routesTy[0]['_upsell']['origin']);
same('thank you: the page unchanged', ['/thank-you', 'h-own-thank-you'], [$routesTy[0]['slug'], $routesTy[0]['content_hash']]);
same('thank you: no cookie needed', null, $cty);
same('thank you: no slug of its own → unchanged', [[$route('/thank-you')], null], upsell_routes([$route('/thank-you')], $gate, make_request(['REQUEST_URI' => '/thank-you'])));

// The pre-20261014d entry point (an older respond.php mid-deploy): the route as it is.
same('compat: upsell_route passes the route through', [$up1, null], upsell_route($up1, $gate, $req6));

// Not an upsell step: unchanged.
same('other path: unchanged', [[$route('/vip', true)], null], upsell_routes([$route('/vip', true)], $gate, make_request(['REQUEST_URI' => '/vip'])));

// The upsell pages the resolver must have on disk.
$refs = upsell_content_refs($gate);
same('refs: every upsell page once', [$pUp1, $pUp1b, $pUp1new, $pUp1c], array_column($refs, 'page_id'));
same('refs: with its served slug and hash', ['page_id' => $pUp1new, 'slug' => '/', 'hash' => 'h-up1new'], $refs[2]);

// The tracker's parameters and the response end to end.
same('track params: offer and downsells', ['o' => 'VKWHeu02', 'ds' => 'DW1CODE1,DW2CODE1'], upsell_track_params(['offer' => 'VKWHeu02', 'downsells' => ['DW1CODE1', '', 'DW2CODE1']]));
same('track params: what was served', 'g6|f1|' . $pUp1new, upsell_track_params(['offer' => '', 'hit' => ['g' => 'g6', 'fl' => 'f1', 'p' => $pUp1new]])['u'] ?? null);
same('track params: none', [], upsell_track_params(null));
$hash = 'up-test-' . bin2hex(random_bytes(4));
cache_put_content($hash, '<html><head><title>Up</title></head><body><button data-pag-yes data-pag-offer="{{upsell.offer}}">Yes</button><div data-pag-offer="{{upsell.downsell1}}"></div></body></html>');
$served = ['content_hash' => $hash, 'funnel' => false] + $r6;
[$status, $headers, $body] = serve_slug($served, $req6);
same('serve: 200', 200, $status);
check('serve: the offer code in the page', str_contains((string) $body, 'data-pag-offer="' . $r6['placeholders']['upsell.offer'] . '"'));
check('serve: the downsell code in the page', str_contains((string) $body, 'data-pag-offer="DW1CODE1"'));
check('serve: the vendor tracker, origin vendor_up1, the upsell page\'s id, the codes', preg_match('~<head><script data-dop-track async src="/_dop/dot\.js\?v=[0-9a-f]{10}&amp;origin=vendor_up1&amp;page_id=' . $r6['page_id'] . '&amp;o=' . $r6['placeholders']['upsell.offer'] . '&amp;ds=DW1CODE1%2CDW2CODE1&amp;u=g6%7Cf1%7C' . $r6['page_id'] . '"></script>~', (string) $body) === 1, substr((string) $body, 0, 300));
check('serve: the ETag has the pick', str_contains($headers['ETag'], '-u'));
check('serve: varies by Cookie', str_contains($headers['Vary'], 'Cookie'));
// The load notice (beacon.php): an upsell step carries it like a funnel page — signals, load,
// interaction, time on page, read depth on its hit — but none of a funnel page's other extras.
check('notice: an upsell step (the gate\'s safe match) carries it', beacon_notice_applies(['match_type' => 'GATE-SAFE'] + $r6, $req6));
check('notice: but it is no funnel page (no page_id cookie, no CTA)', !beacon_applies(['match_type' => 'GATE-SAFE'] + $r6, $req6));
check('notice: the thank you page too', beacon_notice_applies(['match_type' => 'GATE-SAFE'] + $routesTy[0], make_request(['REQUEST_URI' => '/thank-you'])));
check('notice: a vendor page outside the funnel (/vip): no', !beacon_notice_applies(['match_type' => 'GATE-SAFE'] + $route('/vip', true), make_request(['REQUEST_URI' => '/vip'])));
check('notice: a non-HTML upsell response: no', !beacon_notice_applies(['content_type' => 'application/json'] + $r6, $req6));
check('serve: the notice script in the page', str_contains((string) $body, '"/_dop/l"'));
check('serve: the ETag has the notice version', str_contains($headers['ETag'], BEACON_ETAG));
$own = 'up-own-' . bin2hex(random_bytes(4));
cache_put_content($own, '<html><head><script src="https://cdn.example/dot.js"></script></head><body></body></html>');
[, , $ownBody] = serve_slug(['content_hash' => $own] + $served, $req6);
check('serve: a page with its own dot.js gets no second one', !str_contains((string) $ownBody, 'data-dop-track'));

// decide(): the gate serves the upsell page at /up1 (the vendor page has no /up1) and sets dop_uv;
// a path no page has and no step names is still a 404.
$gateDecide = $gate + ['status' => 'ACTIVE', 'rules' => [], 'gate_slugs' => ['*/up1'], 'funnels' => []];
cache_put_content('h-up1b', '<html><head></head><body>basic</body></html>');
[$st, $hd, $bd] = decide([$up1], make_request(['REQUEST_URI' => '/up1?front=2']), $gateDecide);
same('decide: /up1 → the basic upsell page', [200, true], [$st, str_contains((string) $bd, '<body>basic')]);
check('decide: with the notice', str_contains((string) $bd, '"/_dop/l"'));
check('decide: the visitor cookie', str_starts_with(implode(' ', (array) ($hd['Set-Cookie'] ?? [])), 'dop_uv='), json_encode($hd['Set-Cookie'] ?? null));
same('decide: /nothing → 404', 404, decide([$route('/nothing')], make_request(['REQUEST_URI' => '/nothing']), $gateDecide)[0]);

// ── Aliases (20261015c): a step is also served at <the vendor page's folder> + its path and at its own
// `aliases`; when two vendor pages of the domain claim a path, the one whose folder holds it wins. ──
$vpBg = '55555555-5555-4555-8555-555555555555';
$bgFunnelId = '66666666-6666-4666-8666-666666666666';
$pBg1 = '33333333-3333-4333-8333-000000000011';
$gateA = $gate;
$gateA['vendor'] = [$vp => ['folder' => '', 'product' => 'honey-peak-gelatin'], $vpBg => ['folder' => '/bg', 'product' => 'honey-peak-drops']];
$gateA['upsell'][$vpBg] = [
    'id' => $bgFunnelId,
    'front_param' => 'front',
    'flows' => [],
    'steps' => [
        ['id' => 'up1', 'slug' => '/up1', 'aliases' => ['/bg/up1v2'], 'groups' => [
            ['id' => 'gall', 'name' => 'All buyers', 'fronts' => [], 'pages' => ['default' => [['page_id' => $pBg1, 'weight' => 100]]], 'offers' => [['offer' => 'up1', 'weight' => 100]]],
        ]],
        ['id' => 'ty', 'slug' => '/thank-you'],
    ],
    'pages' => [$pBg1 => ['slug' => '/', 'hash' => 'h-bg1', 'type' => 'text/html; charset=utf-8']],
];
// The root page's funnel also names /bg/up1v2 (on its Upsell 2): the /bg page owns that folder.
$gateA['upsell'][$vp]['steps'][1]['aliases'] = ['/bg/up1v2'];
$routeBg = static fn(string $slug, bool $has = false): array => ['page_id' => $vpBg, 'slug_id' => $has ? 'sid-bg-' . $slug : null,
    'content_hash' => $has ? 'h-own-bg' . str_replace('/', '-', $slug) : null, 'content_type' => $has ? 'text/html; charset=utf-8' : null] + $route($slug, $has);

// The paths of a step: the same as the TS side (vendor-paths.ts stepPaths, vendor-cases.json).
foreach ($vendorCases['step_paths'] as $i => $c) {
    same("shared step paths case $i (PHP = TS)", $c['paths'], upsell_step_paths(['slug' => $c['canonical'], 'aliases' => $c['aliases']], $c['folder']));
}
same('aliases: the implicit one in the page\'s folder', 'up1', upsell_step($routeBg('/bg/up1'), $gateA, '/bg/up1')[1]['id'] ?? null);
same('aliases: the thank you page in the folder', 'ty', upsell_step($routeBg('/bg/thank-you'), $gateA, '/bg/thank-you')[1]['id'] ?? null);
same('aliases: an explicit one', 'up1', upsell_step($routeBg('/bg/up1v2'), $gateA, '/bg/up1v2')[1]['id'] ?? null);
same('aliases: case-insensitive', 'up1', upsell_step($routeBg('/bg/up1v2'), $gateA, '/BG/UP1V2')[1]['id'] ?? null);
same('aliases: the canonical path still', 'up1', upsell_step($routeBg('/up1'), $gateA, '/up1')[1]['id'] ?? null);
same('aliases: a page at the root has no folder alias', null, upsell_step($up1, $gateA, '/bg/up1'));
same('aliases: another path of the folder is no step', null, upsell_step($routeBg('/bg/privacy.html'), $gateA, '/bg/privacy.html'));
$gateOld = $gateA;
unset($gateOld['vendor']);
same('aliases: a cache without gate.vendor — no folder alias', null, upsell_step($routeBg('/bg/up1'), $gateOld, '/bg/up1'));
same('aliases: … the explicit ones still', 'up1', upsell_step($routeBg('/bg/up1v2'), $gateOld, '/bg/up1v2')[1]['id'] ?? null);
same('folder: a bad value reads as the root', '', upsell_page_folder(['vendor' => [$vp => ['folder' => '/bg/../x']]], $vp));

// Two vendor pages claim the same path: the folder's owner wins, whatever the routes' order.
[$rAlias] = upsell_routes([$up1 = $route('/bg/up1v2'), $routeBg('/bg/up1v2')], $gateA, make_request(['REQUEST_URI' => '/bg/up1v2']));
same('conflict: /bg/up1v2 → the /bg page\'s funnel', [$bgFunnelId, 'up1', $pBg1], [$rAlias[0]['_upsell']['hit']['f'], $rAlias[0]['_upsell']['hit']['s'], $rAlias[0]['page_id']]);
same('conflict: the requested path stays the slug', '/bg/up1v2', $rAlias[0]['slug']);
[$rRoot] = upsell_routes([$routeBg('/up1'), $route('/up1')], $gateA, make_request(['REQUEST_URI' => '/up1?front=2']));
same('conflict: /up1 → the root page\'s funnel (the /bg page lives in another folder)', $funnelId, $rRoot[0]['_upsell']['hit']['f']);
same('conflict: the canonical path is still the step for one page alone', $bgFunnelId, upsell_routes([$routeBg('/up1')], $gateA, make_request(['REQUEST_URI' => '/up1']))[0][0]['_upsell']['hit']['f'] ?? null);
same('canonical of a path: an explicit alias', '/up1', upsell_step_canonical($gateA, '/bg/up1v2'));
same('canonical of a path: the folder alias', '/thank-you', upsell_step_canonical($gateA, '/bg/thank-you'));
same('canonical of a path: no step', null, upsell_step_canonical($gateA, '/bg/privacy.html'));
same('canonical of a path: no upsell in the gate', null, upsell_step_canonical(['funnels' => []], '/bg/up1v2'));

// No version to serve at an alias: like today — the vendor page's own slug at that path, else 404.
$gateNoBg = $gateA;
$gateNoBg['upsell'][$vpBg]['pages'] = [];
[$rOwn] = upsell_routes([$routeBg('/bg/up1', true)], $gateNoBg, make_request(['REQUEST_URI' => '/bg/up1']));
same('alias, no version: the vendor page\'s own /bg/up1', [$vpBg, 'h-own-bg-bg-up1', 'up1'], [$rOwn[0]['page_id'], $rOwn[0]['content_hash'], $rOwn[0]['_upsell']['hit']['s']]);
same('alias, no version, no slug of its own: unchanged (404)', [[$routeBg('/bg/up1')], null], upsell_routes([$routeBg('/bg/up1')], $gateNoBg, make_request(['REQUEST_URI' => '/bg/up1'])));
[$rTyBg] = upsell_routes([$routeBg('/bg/thank-you', true)], $gateA, make_request(['REQUEST_URI' => '/bg/thank-you']));
same('alias: /bg/thank-you serves the page\'s own slug, as the Thank you step', ['vendor_thank_you', 'h-own-bg-bg-thank-you'], [$rTyBg[0]['_upsell']['origin'], $rTyBg[0]['content_hash']]);

// The gate: an alias reaches the funnel like its step (the step's path is allowed); another path doesn't.
$fp = '77777777-7777-4777-8777-777777777777';
$gateGate = $gateA + ['status' => 'ACTIVE', 'rules' => [], 'gate_slugs' => ['*/up1'],
    'funnels' => ['F9' => ['split' => [['page_id' => $fp, 'content_hash' => 'h-fp', 'content_type' => 'text/html; charset=utf-8', 'weight' => 100]]]]];
$gateGate['gate_slugs'] = ['*/up1'];
same('gate: an explicit alias with a funnel token → the funnel', GATE_MATCH, gate_pick([$routeBg('/bg/up1v2', true)], $gateGate, make_request(['REQUEST_URI' => '/bg/up1v2?sub1=%5BF9%5D']))['match_type'] ?? null);
same('gate: an exact /up1 allows its alias too', GATE_MATCH, gate_pick([$routeBg('/bg/up1v2', true)], ['gate_slugs' => ['/up1']] + $gateGate, make_request(['REQUEST_URI' => '/bg/up1v2?sub1=%5BF9%5D']))['match_type'] ?? null);
same('gate: another path of the folder is not allowed', 'slug_not_allowed', gate_pick([$routeBg('/bg/privacy.html', true)], $gateGate, make_request(['REQUEST_URI' => '/bg/privacy.html?sub1=%5BF9%5D']))['_gate_reason'] ?? null);
$noUpsell = $gateGate;
unset($noUpsell['upsell']);
same('gate: without an upsell funnel the alias is just a slug', 'slug_not_allowed', gate_pick([$routeBg('/bg/up1v2', true)], $noUpsell, make_request(['REQUEST_URI' => '/bg/up1v2?sub1=%5BF9%5D']))['_gate_reason'] ?? null);

// ── The vendor page's landing (vendor_front) and the product on the tracker (20261015b/c) ──
$landing = $routeBg('/bg', true);
same('landing: the folder\'s root gets vendor_front and the product', ['origin' => 'vendor_front', 'product' => 'honey-peak-drops'], vendor_route_mark($landing, $gateA, make_request(['REQUEST_URI' => '/bg']))['_vendor'] ?? null);
same('landing: the root page\'s "/"', 'honey-peak-gelatin', vendor_route_mark($route('/', true), $gateA, make_request())['_vendor']['product'] ?? null);
same('landing: a legal page is not', null, vendor_route_mark($routeBg('/bg/privacy.html', true), $gateA, make_request(['REQUEST_URI' => '/bg/privacy.html']))['_vendor'] ?? null);
same('landing: a page that is not a vendor page', null, vendor_route_mark(['page_id' => '88888888-8888-4888-8888-888888888888'] + $route('/', true), $gateA, make_request())['_vendor'] ?? null);
same('landing: no slug there (a 404)', null, vendor_route_mark($routeBg('/bg'), $gateA, make_request(['REQUEST_URI' => '/bg']))['_vendor'] ?? null);
same('landing: an upsell step keeps its own mark', null, vendor_route_mark(['_upsell' => ['origin' => 'vendor_up1']] + $landing, $gateA, make_request(['REQUEST_URI' => '/bg']))['_vendor'] ?? null);
same('product id: not a core key → none', null, vendor_product_id(['vendor' => [$vp => ['product' => 'Bad Id']]], $vp));
same('track params: product and step', ['product_id' => 'honey-peak-drops', 'step' => 'vendor_front'], vendor_track_params(['origin' => 'vendor_front', 'product' => 'honey-peak-drops']));
same('track params: no product → none', [], vendor_track_params(['origin' => 'vendor_front', 'product' => null]));

$landHash = 'land-' . bin2hex(random_bytes(4));
cache_put_content($landHash, '<html><head><title>BG</title></head><body>front</body></html>');
$marked = vendor_route_mark(['content_hash' => $landHash, 'funnel' => false, 'match_type' => 'GATE-SAFE'] + $landing, $gateA, make_request(['REQUEST_URI' => '/bg']));
[$ls, $lh, $lb] = serve_slug($marked, make_request(['REQUEST_URI' => '/bg']));
same('landing serve: 200', 200, $ls);
check('landing serve: dot.js as vendor_front, the vendor page\'s id, the product and the step',
    str_contains((string) $lb, '<head><script data-dop-track async src="/_dop/dot.js?v=' . tracker_version(TRACKER_DOT_JS) . '&amp;origin=vendor_front&amp;page_id=' . $vpBg . '&amp;product_id=honey-peak-drops&amp;step=vendor_front"></script>'), substr((string) $lb, 0, 300));
check('landing serve: the load notice', str_contains((string) $lb, '"/_dop/l"'));
check('landing serve: the ETag has the vendor tracker and the notice', str_contains($lh['ETag'], vendor_etag($marked['_vendor'])) && str_contains($lh['ETag'], BEACON_ETAG));
check('landing: the notice applies (a dop_v visit), no funnel page extras', beacon_notice_applies($marked, make_request(['REQUEST_URI' => '/bg'])) && !beacon_applies($marked, make_request(['REQUEST_URI' => '/bg'])));
same('landing serve: 304 with the same ETag', 304, serve_slug($marked, make_request(['REQUEST_URI' => '/bg', 'HTTP_IF_NONE_MATCH' => $lh['ETag']]))[0]);
$noCore = $gateA;
$noCore['vendor'][$vpBg]['product'] = null;
[, $nh, $nb] = serve_slug(vendor_route_mark(['content_hash' => $landHash, 'funnel' => false] + $landing, $noCore, make_request(['REQUEST_URI' => '/bg'])), make_request(['REQUEST_URI' => '/bg']));
check('landing, no core product: vendor_front without product_id/step', str_contains((string) $nb, '&amp;origin=vendor_front&amp;page_id=' . $vpBg . '"') && !str_contains((string) $nb, 'product_id='), substr((string) $nb, 0, 300));
check('landing: a linked product changes the ETag', $nh['ETag'] !== $lh['ETag']);
[, , $jb] = serve_slug(['content_type' => 'application/json'] + $marked, make_request(['REQUEST_URI' => '/bg']));
check('landing that is not HTML: no tracker', !str_contains((string) $jb, 'data-dop-track'));
// A non-VENDOR page at "/" (any other domain): nothing new.
$plainHash = 'plain-' . bin2hex(random_bytes(4));
cache_put_content($plainHash, '<html><head></head><body>safe</body></html>');
$plain = ['page_id' => '88888888-8888-4888-8888-888888888888', 'content_hash' => $plainHash, 'funnel' => false, 'match_type' => 'GATE-SAFE'] + $route('/', true);
[, $ph, $pb] = serve_slug(vendor_route_mark($plain, $gateA, make_request()), make_request());
check('a non-vendor page: no tracker, no notice', !str_contains((string) $pb, 'data-dop-track') && !str_contains((string) $pb, '"/_dop/l"'));
check('a non-vendor page: no vendor ETag piece', !str_contains($ph['ETag'], '-w'));

// An upsell step of a linked product: its tracker carries the product and the step too.
$reqBgUp = make_request(['REQUEST_URI' => '/bg/up1', 'HTTP_COOKIE' => 'dop_uv=' . $uv]);
[$rBgUp] = upsell_routes([$routeBg('/bg/up1')], $gateA, $reqBgUp);
same('upsell step: the product on the route', 'honey-peak-drops', $rBgUp[0]['_upsell']['product'] ?? null);
cache_put_content('h-bg1', '<html><head></head><body><button data-pag-yes data-pag-offer="{{upsell.offer}}">Yes</button></body></html>');
[, , $ub] = serve_slug(['funnel' => false] + $rBgUp[0], $reqBgUp);
check('upsell step: dot.js as vendor_up1 with the product and the step', str_contains((string) $ub, '&amp;product_id=honey-peak-drops&amp;step=vendor_up1"'), substr((string) $ub, 0, 400));

// decide(): the landing end to end (the gate's safe page at /bg gets the tracker), and a vendor domain's legal page doesn't.
$gateDecideA = $gateA + ['status' => 'ACTIVE', 'rules' => [], 'gate_slugs' => ['*/up1'], 'funnels' => []];
[$ds, $dh, $db] = decide([['content_hash' => $landHash] + $landing], make_request(['REQUEST_URI' => '/bg']), $gateDecideA);
check('decide: /bg → the landing with dot.js as vendor_front', $ds === 200 && str_contains((string) $db, 'origin=vendor_front'), (string) $db);
[, , $dlb] = decide([['content_hash' => $plainHash] + $routeBg('/bg/privacy.html', true)], make_request(['REQUEST_URI' => '/bg/privacy.html']), $gateDecideA);
check('decide: /bg/privacy.html → no tracker', !str_contains((string) $dlb, 'data-dop-track'));
