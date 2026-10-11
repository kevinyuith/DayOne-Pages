<?php
declare(strict_types=1);

// ── cta.php: the funnel's CTA under the VSL, drawn by the server at the pitch ──

$cA = 'aaaaaaaa-0000-4000-8000-00000000c7a1';
$cB = 'bbbbbbbb-0000-4000-8000-00000000c7b2';
$cOld = 'cccccccc-0000-4000-8000-00000000c7c3';
$hA = str_repeat('a1', 32);
$hB = str_repeat('b2', 32);
$ctaV = 'dddddddddddddddddddddd01';
$ctaV2 = 'dddddddddddddddddddddd02';
$ctaPid = '44444444-aaaa-4aaa-8aaa-0000000000c7';
$fixedC = static fn (int $n) => static fn (int $max): int => min($n, $max - 1);
$ctas = [['id' => $cA, 'weight' => 60, 'content_hash' => $hA], ['id' => $cB, 'weight' => 40, 'content_hash' => $hB]];
$vslOn = [['id' => $ctaV, 'weight' => 50, 'cta' => true], ['id' => $ctaV2, 'weight' => 50]];

// The list: valid ids and hashes with a share above 0.
same('list: two CTAs', [$cA, $cB], array_column(cta_list($ctas), 'id'));
same('list: paused (0), bad id, bad hash and junk are out', [], cta_list([['id' => $cA, 'weight' => 0, 'content_hash' => $hA], ['id' => 'x', 'weight' => 50, 'content_hash' => $hA], ['id' => $cB, 'weight' => 50, 'content_hash' => 'nothex'], 'junk']));
same('list: none', [], cta_list(null));

// Which VSLs take the server's CTA.
check('video on "server"', cta_video_on($vslOn, $ctaV));
check('video on VTurb (no cta): no', !cta_video_on($vslOn, $ctaV2));
check('no video: no', !cta_video_on($vslOn, null) && !cta_video_on($vslOn, ''));
check('cta must be exactly true', !cta_video_on([['id' => $ctaV, 'weight' => 100, 'cta' => 'true']], $ctaV));

// The draw: by the shares, sticky in dop_cta.
$list = cta_list($ctas);
same('draw 0 of 100 → A (60%)', $cA, cta_draw($list, [], $fixedC(0))['pick']['id']);
same('draw 60 of 100 → B (40%)', $cB, cta_draw($list, [], $fixedC(60))['pick']['id']);
same('new cookie: the drawn CTA', $cA, cta_draw($list, [], $fixedC(0))['cookie']);
same('cookie wins: a visitor who got B stays on B', $cB, cta_draw($list, ['dop_cta' => $cB], $fixedC(0))['pick']['id']);
same('… and the cookie isn\'t sent again', null, cta_draw($list, ['dop_cta' => $cB], $fixedC(0))['cookie']);
same('another funnel\'s CTA stays in the cookie, this one first', "$cA,$cOld", cta_draw($list, ['dop_cta' => $cOld], $fixedC(0))['cookie']);
same('a CTA that left the split (paused, unpublished): draws again', $cA, cta_draw([$list[0]], ['dop_cta' => $cB], $fixedC(99))['pick']['id']);
same('malformed cookie: ignored', $cB, cta_draw($list, ['dop_cta' => '<x>,' . $cB], $fixedC(0))['pick']['id']);
same('reserve: the largest share', $cA, cta_reserve($list)['id']);
same('reserve on a tie: the first', $cA, cta_reserve([['id' => $cA, 'weight' => 50, 'hash' => $hA], ['id' => $cB, 'weight' => 50, 'hash' => $hB]])['id']);

// The page: &cta= mode and the reserve.
cache_put_content($hA, '<div class="sp">CTA A <a href="https://checkout.directdayone.com?u=https://pay.x/P-1?aff=Z&b=2">2</a></div>');
$route = ['ctas' => $ctas, 'vsl' => $vslOn];
$m = cta_page_mode($route, $ctaV, []);
same('page: video on "server", a new visitor → mode 1 (ask at the pitch)', 1, $m['mode']);
same('… the reserve is the largest share, read from disk', [$cA, true], [$m['reserve']['id'], str_contains((string) $m['reserve_html'], 'CTA A')]);
same('page: a returning visitor (dop_cta has a live CTA) → mode 2 (ask at once)', 2, cta_page_mode($route, $ctaV, ['dop_cta' => $cB])['mode']);
same('page: dop_cta with a CTA no longer live → mode 1', 1, cta_page_mode($route, $ctaV, ['dop_cta' => $cOld])['mode']);
same('page: video on VTurb → nothing', null, cta_page_mode($route, $ctaV2, []));
same('page: no live CTA → nothing', null, cta_page_mode(['ctas' => [], 'vsl' => $vslOn], $ctaV, []));
$missing = cta_page_mode(['ctas' => [['id' => $cB, 'weight' => 100, 'content_hash' => $hB]], 'vsl' => $vslOn], $ctaV, []);
check('page: reserve not on disk → no reserve now, fetched after the response', $missing['reserve'] === null && $missing['reserve_html'] === null && isset(cta_prefetch_later(null)[$cB]));

same('reserve: inert, before </body>', '<body>x<template data-dop-cta-reserve><b>R</b></template></body>', cta_reserve_inject('<body>x</body>', '<b>R</b>'));
same('slot: the page\'s own <div data-dop-cta>', '<p>a</p><div data-dop-cta data-dop-cta-shown="reserve"><b>R</b></div><p>b</p>', cta_slot_inject('<p>a</p><div data-dop-cta></div><p>b</p>', '<b>R</b>'));
same('slot: right after the player when the page has none', '<vturb-smartplayer id="v"></vturb-smartplayer><div data-dop-cta data-dop-cta-shown="reserve"><b>R</b></div><p>b</p>', cta_slot_inject('<vturb-smartplayer id="v"></vturb-smartplayer><p>b</p>', '<b>R</b>'));

// serve_slug: a funnel page the gate served, its drawn video on "server".
$ctaRoute = ['slug_id' => $ctaPid, 'content_hash' => 'c7a0page', 'content_type' => 'text/html', 'funnel' => false, 'match_type' => 'GATE', 'page_id' => $ctaPid, 'vsl' => [['id' => $ctaV, 'weight' => 100, 'cta' => true]], 'ctas' => $ctas];
cache_put_content('c7a0page', '<html><head></head><body><vturb-smartplayer id="vid-{{video_id}}"></vturb-smartplayer></body></html>');
[$st, $hd, $body] = serve_slug($ctaRoute, make_request());
same('serve: 200', 200, $st);
check('serve: dot.js with &cta=1', str_contains((string) $body, htmlspecialchars(track_url('lander', $ctaPid, $ctaV, 1))), (string) $body);
check('serve: the reserve (A) in a <template> before </body>', str_contains((string) $body, '<template data-dop-cta-reserve><div class="sp">CTA A') && str_ends_with(trim((string) $body), '</template></body></html>'), (string) $body);
check('serve: the CTA goes into the ETag', str_contains((string) $hd['ETag'], '-c1' . substr($hA, 0, 8)), (string) $hd['ETag']);
[, , $body2] = serve_slug($ctaRoute, make_request(['HTTP_COOKIE' => "dop_cta=$cB"]));
check('serve: a returning visitor → &cta=2', str_contains((string) $body2, htmlspecialchars(track_url('lander', $ctaPid, $ctaV, 2))), (string) $body2);
[, , $body3] = serve_slug(['vsl' => [['id' => $ctaV, 'weight' => 100]]] + $ctaRoute, make_request());
check('serve: the video on VTurb → no &cta, no reserve', !str_contains((string) $body3, 'cta=') && !str_contains((string) $body3, 'data-dop-cta'), (string) $body3);
[, , $body4] = serve_slug(['match_type' => 'GATE-SAFE'] + $ctaRoute, make_request());
check('serve: the safe page → no CTA', !str_contains((string) $body4, 'data-dop-cta') && !str_contains((string) $body4, 'cta='), (string) $body4);
cache_put_content('c7a0own', '<html><head></head><body><vturb-smartplayer id="vid-{{video_id}}"></vturb-smartplayer><script src="/_dop/dot.js?origin=lander"></script></body></html>');
[, , $body5] = serve_slug(['content_hash' => 'c7a0own'] + $ctaRoute, make_request());
check('serve: a page with its own tracker → the reserve straight under the player', str_contains((string) $body5, '</vturb-smartplayer><div data-dop-cta data-dop-cta-shown="reserve"><div class="sp">CTA A') && !str_contains((string) $body5, 'data-dop-cta-reserve'), (string) $body5);

// The gate copies the funnel's CTAs to its route.
$gateC = ['status' => 'ACTIVE', 'gate_slugs' => ['/'], 'rules' => [], 'funnels' => ['F8' => [
    'name' => 'AFRICAN RITUAL',
    'split' => [['page_id' => $ctaPid, 'content_type' => 'text/html', 'content_hash' => 'c7a0page', 'weight' => 100]],
    'vsl' => [['id' => $ctaV, 'weight' => 100, 'cta' => true]],
    'ctas' => $ctas,
]]];
$gr = gate_pick([['domain_id' => 'd1', 'action' => 'SERVE', 'slug' => '/', 'slug_id' => 's', 'content_hash' => 'h', 'priority' => 0, 'match_type' => 'EXACT', 'conditions' => []]], $gateC, make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('[F8] x')]));
same('gate: the funnel route carries its CTAs', [$cA, $cB], array_column($gr['ctas'] ?? [], 'id'));

// GET /_dop/cta
$gateOf = static fn (string $host): array => $gateC;
$noFetch = static function (array $ids): array { throw new RuntimeException('no fetch expected'); };
$ctaReq = static fn (string $q, string $cookie = '', string $method = 'GET'): Request => make_request(['REQUEST_METHOD' => $method, 'REQUEST_URI' => "/_dop/cta?$q", 'HTTP_COOKIE' => $cookie]);
same('handle: another path → null', null, handle_cta(make_request(['REQUEST_URI' => '/_dop/ctax']), $gateOf, $noFetch));
same('handle: POST → 405', 405, handle_cta($ctaReq("page=$ctaPid&video=$ctaV", '', 'POST'), $gateOf, $noFetch)[0]);
same('handle: bad page or video → 204', [204, 204], [handle_cta($ctaReq("page=x&video=$ctaV"), $gateOf, $noFetch)[0], handle_cta($ctaReq("page=$ctaPid&video=zz"), $gateOf, $noFetch)[0]]);
same('handle: a page in no funnel → 204', 204, handle_cta($ctaReq("page=55555555-aaaa-4aaa-8aaa-0000000000c7&video=$ctaV"), $gateOf, $noFetch)[0]);
same('handle: a video on VTurb → 204', 204, handle_cta($ctaReq("page=$ctaPid&video=$ctaV2"), $gateOf, $noFetch)[0]);
[$st, $hd, $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $noFetch, $fixedC(0));
$json = json_decode((string) $body, true);
same('handle: 200 with A (draw 0)', [200, $cA], [$st, $json['cta_id'] ?? null]);
check('… its HTML from disk', str_contains((string) ($json['html'] ?? ''), 'CTA A'), (string) $body);
check('… no-store, JSON, and the dop_cta cookie', $hd['Cache-Control'] === 'no-store' && str_starts_with($hd['Content-Type'], 'application/json') && str_starts_with($hd['Set-Cookie'][0] ?? '', "dop_cta=$cA;"), json_encode($hd));
[$st, $hd] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV", "dop_cta=$cA"), $gateOf, $noFetch, $fixedC(99));
same('handle: the same visitor again → the same CTA, no new cookie', [200, false], [$st, isset($hd['Set-Cookie'])]);
// B's HTML isn't on disk: fetched from the database, then kept by its hash.
$fetched = [];
$fetchB = static function (array $ids) use (&$fetched, $cB, $hB): array {
    $fetched[] = $ids;
    return ['ok' => true, 'rows' => [['cta_id' => $cB, 'content_hash' => $hB, 'html' => '<div>CTA B</div>']]];
};
[$st, , $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $fetchB, $fixedC(60));
same('handle: B not on disk → fetched once, served', [200, [[$cB]], 'CTA B'], [$st, $fetched, strip_tags((string) (json_decode((string) $body, true)['html'] ?? ''))]);
same('… and now it\'s on disk', '<div>CTA B</div>', cache_read_content($hB));
$hC = str_repeat('c3', 32);
$gateDown = static fn (string $host): array => ['funnels' => ['F8' => ['split' => [['page_id' => $ctaPid]], 'vsl' => [['id' => $ctaV, 'weight' => 100, 'cta' => true]], 'ctas' => [['id' => $cOld, 'weight' => 100, 'content_hash' => $hC]]]]];
same('handle: the HTML can\'t be fetched → 503 (dot.js shows the reserve)', 503, handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateDown, static fn (array $ids): array => ['ok' => false, 'error' => 'HTTP 503'])[0]);

// The tracker's URL.
same('track url: &cta= after the video', '&video_id=' . $ctaV . '&cta=1', substr(track_url('lander', $ctaPid, $ctaV, 1), strpos(track_url('lander', $ctaPid, $ctaV, 1), '&video_id=')));
check('track url: no &cta= without a mode', !str_contains(track_url('lander', $ctaPid, $ctaV), 'cta='));
check('dot.js: reads &cta=, asks /_dop/cta and sends cta_id', str_contains(TRACKER_DOT_JS, "/[?&]cta=([12])") && str_contains(TRACKER_DOT_JS, "'/_dop/cta?page='") && str_contains(TRACKER_DOT_JS, 'payload.cta_id = ctaId'));
check('dot.js: the CTA is fetched hidden CTA_LEAD (3 s) before the pitch and shown at the pitch; cta_id only from the reveal', str_contains(TRACKER_DOT_JS, 'var CTA_LEAD = 3;') && str_contains(TRACKER_DOT_JS, 't >= p - CTA_LEAD && t < p') && str_contains(TRACKER_DOT_JS, 'if (ctaPending) ctaId = ctaPending;'));
