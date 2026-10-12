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
same('page: no CTA in the resolve and no copy of the block yet → mode 1, no reserve (dot.js still asks at the pitch)', ['mode' => 1, 'reserve' => null, 'reserve_html' => null, 'tag' => ''], cta_page_mode(['ctas' => [], 'vsl' => $vslOn], $ctaV, []));
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
// The test link: ?dop_cta=<cta id> → &cta=3, whatever the video's mode, no reserve.
same('preview id: from the page query', $cB, cta_preview_id("sub1=x&dop_cta=$cB"));
same('preview id: not a uuid, or absent → null', [null, null], [cta_preview_id('dop_cta=x'), cta_preview_id('sub1=x')]);
same('page: the test link → mode 3, no reserve', ['mode' => 3, 'reserve' => null, 'reserve_html' => null, 'tag' => ''], cta_page_mode($route, $ctaV2, [], $cB));
[, $hd6, $body6] = serve_slug(['vsl' => [['id' => $ctaV, 'weight' => 100]]] + $ctaRoute, make_request(['REQUEST_URI' => "/?dop_cta=$cB"]));
check('serve: the test link → &cta=3 even on a VTurb video, no reserve', str_contains((string) $body6, htmlspecialchars(track_url('lander', $ctaPid, $ctaV, 3))) && !str_contains((string) $body6, 'data-dop-cta-reserve'), (string) $body6);
check('… and the ETag says so', str_contains((string) $hd6['ETag'], '-c3'), (string) $hd6['ETag']);

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
cta_draw_purge();
$gateOf = static fn (string $host): array => $gateC;
// pages.cta_draw_get: the VSL's block, its designs and offer (one row; none = nothing to show).
$drawOf = static fn (array $ctas, ?array $offer = null, string $block = 'default'): Closure
    => static fn (string $page, string $vid): array => ['ok' => true, 'rows' => [['block' => $block, 'ctas' => $ctas, 'offer' => $offer]]];
$drawAB = $drawOf($ctas);
$noFetch = static function (array $ids): array { throw new RuntimeException('no fetch expected'); };
$ctaReq = static fn (string $q, string $cookie = '', string $method = 'GET'): Request => make_request(['REQUEST_METHOD' => $method, 'REQUEST_URI' => "/_dop/cta?$q", 'HTTP_COOKIE' => $cookie]);
same('handle: another path → null', null, handle_cta(make_request(['REQUEST_URI' => '/_dop/ctax']), $gateOf, $noFetch));
same('handle: POST → 405', 405, handle_cta($ctaReq("page=$ctaPid&video=$ctaV", '', 'POST'), $gateOf, $noFetch)[0]);
same('handle: bad page or video → 204', [204, 204], [handle_cta($ctaReq("page=x&video=$ctaV"), $gateOf, $noFetch)[0], handle_cta($ctaReq("page=$ctaPid&video=zz"), $gateOf, $noFetch)[0]]);
same('handle: a page in no funnel → 204', 204, handle_cta($ctaReq("page=55555555-aaaa-4aaa-8aaa-0000000000c7&video=$ctaV"), $gateOf, $noFetch)[0]);
same('handle: a video on VTurb → 204', 204, handle_cta($ctaReq("page=$ctaPid&video=$ctaV2"), $gateOf, $noFetch)[0]);
[$st, $hd, $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $noFetch, $fixedC(0), null, $drawAB);
$json = json_decode((string) $body, true);
same('handle: 200 with A (draw 0)', [200, $cA], [$st, $json['cta_id'] ?? null]);
check('… the VSL\'s block kept on disk', (cta_draw_read($ctaPid, $ctaV)['ctas'][0]['id'] ?? null) === $cA);
$noDraw = static function (): array { throw new RuntimeException('no cta_draw_get expected: the copy is fresh'); };
check('… its HTML from disk', str_contains((string) ($json['html'] ?? ''), 'CTA A'), (string) $body);
check('… no-store, JSON, and the dop_cta cookie', $hd['Cache-Control'] === 'no-store' && str_starts_with($hd['Content-Type'], 'application/json') && str_starts_with($hd['Set-Cookie'][0] ?? '', "dop_cta=$cA;"), json_encode($hd));
[$st, $hd] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV", "dop_cta=$cA"), $gateOf, $noFetch, $fixedC(99), null, $noDraw);
same('handle: the same visitor again → the same CTA, no new cookie', [200, false], [$st, isset($hd['Set-Cookie'])]);
// B's HTML isn't on disk: fetched from the database, then kept by its hash.
$fetched = [];
$fetchB = static function (array $ids) use (&$fetched, $cB, $hB): array {
    $fetched[] = $ids;
    return ['ok' => true, 'rows' => [['cta_id' => $cB, 'content_hash' => $hB, 'html' => '<div>CTA B</div>']]];
};
[$st, , $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $fetchB, $fixedC(60), null, $noDraw);
same('handle: B not on disk → fetched once, served', [200, [[$cB]], 'CTA B'], [$st, $fetched, strip_tags((string) (json_decode((string) $body, true)['html'] ?? ''))]);
same('… and now it\'s on disk', '<div>CTA B</div>', cache_read_content($hB));
$hC = str_repeat('c3', 32);
$gateDown = static fn (string $host): array => ['funnels' => ['F8' => ['split' => [['page_id' => $ctaPid]], 'vsl' => [['id' => $ctaV, 'weight' => 100, 'cta' => true]], 'ctas' => [['id' => $cOld, 'weight' => 100, 'content_hash' => $hC]]]]];
cta_draw_purge();
same('handle: the HTML can\'t be fetched → 503 (dot.js shows the reserve)', 503, handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateDown, static fn (array $ids): array => ['ok' => false, 'error' => 'HTTP 503'], null, null, $drawOf([['id' => $cOld, 'weight' => 100, 'content_hash' => $hC]]))[0]);

// The VSL's block (pages.cta_draw_get): its designs, the offer that fills their placements, the copy on disk.
$down = static fn (string $page, string $vid): array => ['ok' => false, 'error' => 'HTTP 503'];
cta_draw_purge();
same('handle: the database says there\'s nothing for this VSL (no row) → 204', 204, handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $noFetch, $fixedC(0), null, static fn (): array => ['ok' => true, 'rows' => []])[0]);
same('… and that is kept too (no second call)', 204, handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $noFetch, $fixedC(0), null, $noDraw)[0]);
cta_draw_purge();
same('handle: a block with nothing the offer can fill → 204', 204, handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $noFetch, $fixedC(0), null, $drawOf([]))[0]);
$cP = 'ffffffff-0000-4000-8000-00000000c7f6';
$hP = str_repeat('f6', 32);
$design = '<h1>CLAIM YOUR <u>{{cta.product}}</u></h1><a href="{{ cta.kit6.checkout }}"><img src="{{cta.kit6.image}}" alt="6 Bottles"><strong>{{cta.kit6.bottles}}</strong> {{cta.kit6.price}}<s>{{cta.kit6.full_total}}</s></a>';
cache_put_content($hP, $design);
$offer = ['product' => 'Glyco "Pezil" & Co', 'kits' => ['6' => ['bottles' => '6 BOTTLES', 'price' => '$49', 'full_total' => '$1074', 'image' => 'https://cdn.x/GLYCO/6-bottles.webp',
    'checkout' => 'https://checkout.directdayone.com?u=https://pay.x/checkout?aff=1&b=6']], 'jars' => ['novo' => ['6' => 'https://cdn.x/GLYCO/novo-6.webp']]];
$filled = '<h1>CLAIM YOUR <u>Glyco &quot;Pezil&quot; &amp; Co</u></h1><a href="https://checkout.directdayone.com?u=https://pay.x/checkout?aff=1&amp;b=6"><img src="https://cdn.x/GLYCO/6-bottles.webp" alt="6 Bottles"><strong>6 BOTTLES</strong> $49<s>$1074</s></a>';
same('fill: the offer into the placements, HTML-escaped', $filled, cta_fill($design, cta_offer($offer)));
check('fill: the jar style\'s photo when the product has it', str_contains(cta_fill($design, cta_offer($offer), 'novo'), 'src="https://cdn.x/GLYCO/novo-6.webp"'));
check('fill: a jar style without that photo → the offer\'s own photo', str_contains(cta_fill($design, cta_offer($offer), 'outro'), 'src="https://cdn.x/GLYCO/6-bottles.webp"'));
same('fill: a kit or field the offer doesn\'t have, or no offer → empty', ['<b></b><i></i>', '<b></b>'], [cta_fill('<b>{{cta.kit3.price}}</b><i>{{cta.kit6.save}}</i>', cta_offer($offer)), cta_fill('<b>{{cta.product}}</b>', null)]);
same('fill: an HTML without placements comes back as it is', '<b>{{video_id}} {{company.name}}</b>', cta_fill('<b>{{video_id}} {{company.name}}</b>', cta_offer($offer)));
same('offer: junk → null', [null, null], [cta_offer('x'), cta_offer(['product' => 'P'])]);
cta_draw_purge();
[$st, , $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $noFetch, $fixedC(0), null, $drawOf([['id' => $cP, 'weight' => 100, 'content_hash' => $hP, 'jar_style' => null]], $offer, 'g-1'));
same('handle: a design with placements → filled with the VSL\'s offer', [200, $cP, $filled], [$st, json_decode((string) $body, true)['cta_id'] ?? null, json_decode((string) $body, true)['html'] ?? null]);
// The page: the reserve from the block's copy, filled, and the offer in the ETag.
$pm = cta_page_mode($route, $ctaV, [], null, $ctaPid);
same('page: the reserve comes from the VSL\'s block (the copy on disk), filled with its offer', [1, $cP, $filled], [$pm['mode'], $pm['reserve']['id'] ?? null, $pm['reserve_html']]);
same('… the tag: the design\'s hash and the offer\'s', substr($hP, 0, 8) . substr(md5((string) json_encode(cta_offer($offer))), 0, 6), $pm['tag']);
same('page: a returning visitor of the block → mode 2; one with a CTA of another block → mode 1', [2, 1], [cta_page_mode($route, $ctaV, ['dop_cta' => $cP], null, $ctaPid)['mode'], cta_page_mode($route, $ctaV, ['dop_cta' => $cA], null, $ctaPid)['mode']]);
// Supabase down: an expired copy stands in (up to STALE_MAX_AGE); with no copy, the resolve's CTAs that need no offer.
$old = static function (int $age) use ($ctaPid, $ctaV, $cP, $hP, $offer): void {
    atomic_write(cta_draw_file($ctaPid, $ctaV), cache_wrap((string) json_encode(['state' => 'ok', 'stored_at' => time() - $age, 'block' => 'default',
        'ctas' => [['id' => $cP, 'weight' => 100, 'content_hash' => $hP]], 'offer' => $offer])));
};
$old(config()['cache_ttl'] + 1);
same('handle: Supabase down, the copy expired → the expired copy', [200, $cP], (static function () use ($ctaReq, $ctaPid, $ctaV, $gateOf, $noFetch, $fixedC, $down): array {
    [$st, , $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $noFetch, $fixedC(0), null, $down);
    return [$st, json_decode((string) $body, true)['cta_id'] ?? null];
})());
$old(config()['stale_max_age'] + 60);
[$st, , $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateOf, $noFetch, $fixedC(0), null, $down);
same('handle: Supabase down, a copy too old → the resolve\'s Default CTAs on disk (A)', [200, $cA], [$st, json_decode((string) $body, true)['cta_id'] ?? null]);
cta_draw_purge();
$gateP = static fn (string $host): array => ['funnels' => ['F8' => ['split' => [['page_id' => $ctaPid]], 'vsl' => [['id' => $ctaV, 'weight' => 100, 'cta' => true]], 'ctas' => [['id' => $cP, 'weight' => 100, 'content_hash' => $hP]]]]];
same('handle: Supabase down, no copy, the only CTA needs an offer → 503 (dot.js shows the reserve)', 503, handle_cta($ctaReq("page=$ctaPid&video=$ctaV"), $gateP, $noFetch, $fixedC(0), null, $down)[0]);
same('page: no copy of the block, the resolve\'s reserve needs an offer → no reserve', [1, null], (static function () use ($ctaV, $ctaPid, $vslOn, $cP, $hP): array {
    $m = cta_page_mode(['ctas' => [['id' => $cP, 'weight' => 100, 'content_hash' => $hP]], 'vsl' => $vslOn], $ctaV, [], null, $ctaPid);
    return [$m['mode'], $m['reserve_html']];
})());
check('page: … and the block is asked for after the response', isset(cta_draw_later(null)["$ctaPid|$ctaV"]));
atomic_write(cta_draw_file($ctaPid, $ctaV), cache_wrap((string) json_encode(['state' => 'none', 'stored_at' => time()])));
same('page: the database said the VSL has nothing → no CTA at all', null, cta_page_mode($route, $ctaV, [], null, $ctaPid));
check('purge: the blocks are forgotten', cta_draw_purge() >= 1 && cta_draw_read($ctaPid, $ctaV) === null);
// The test link: &preview=<cta id> → that CTA (a draft too) from pages.cta_preview_get, no draw, no cookie.
$cDraft = 'eeeeeeee-0000-4000-8000-00000000c7e5';
$asked = [];
$previewGet = static function (string $cta, string $page) use (&$asked, $cDraft): array {
    $asked[] = [$cta, $page];
    return $cta === $cDraft
        ? ['ok' => true, 'rows' => [['cta_id' => $cta, 'content_hash' => str_repeat('e5', 32), 'html' => '<div>CTA DRAFT</div>', 'status' => 'DRAFT']]]
        : ['ok' => true, 'rows' => []];
};
[$st, $hd, $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV2&preview=$cDraft"), $gateOf, $noFetch, $fixedC(0), $previewGet);
$json = json_decode((string) $body, true);
same('handle: preview → 200 with that CTA (a draft), even on a VTurb video', [200, $cDraft, true], [$st, $json['cta_id'] ?? null, $json['preview'] ?? null]);
check('… its HTML, asked for this page, no cookie', str_contains((string) ($json['html'] ?? ''), 'CTA DRAFT') && $asked === [[$cDraft, $ctaPid]] && !isset($hd['Set-Cookie']), json_encode([$asked, $hd]));
same('… and kept by its hash', '<div>CTA DRAFT</div>', cache_read_content(str_repeat('e5', 32)));
same('handle: preview of a CTA not in this page\'s funnel → 204', 204, handle_cta($ctaReq("page=$ctaPid&video=$ctaV&preview=$cOld"), $gateOf, $noFetch, $fixedC(0), $previewGet)[0]);
same('handle: preview on a page in no funnel → 204, nothing asked', 204, handle_cta($ctaReq("page=55555555-aaaa-4aaa-8aaa-0000000000c7&video=$ctaV&preview=$cDraft"), $gateOf, $noFetch, $fixedC(0), static function (): array { throw new RuntimeException('no preview call expected'); })[0]);
same('handle: preview that can\'t be fetched → 204', 204, handle_cta($ctaReq("page=$ctaPid&video=$ctaV&preview=$cDraft"), $gateOf, $noFetch, $fixedC(0), static fn (): array => ['ok' => false, 'error' => 'HTTP 503'])[0]);
$askedV = [];
$previewP = static function (string $cta, string $page, string $vid) use (&$askedV, $design, $offer): array {
    $askedV[] = $vid;
    return ['ok' => true, 'rows' => [['cta_id' => $cta, 'content_hash' => str_repeat('d7', 32), 'html' => $design, 'status' => 'DRAFT', 'jar_style' => 'novo', 'offer' => $offer]]];
};
[$st, , $body] = handle_cta($ctaReq("page=$ctaPid&video=$ctaV&preview=$cP"), $gateOf, $noFetch, $fixedC(0), $previewP);
check('handle: preview of a design with placements → asked with the video, filled with its offer and jar style', $st === 200 && $askedV === [$ctaV]
    && str_contains((string) (json_decode((string) $body, true)['html'] ?? ''), 'src="https://cdn.x/GLYCO/novo-6.webp"') && str_contains((string) (json_decode((string) $body, true)['html'] ?? ''), '<u>Glyco &quot;Pezil&quot; &amp; Co</u>'), (string) $body);

// The tracker's URL.
same('track url: &cta= after the video', '&video_id=' . $ctaV . '&cta=1', substr(track_url('lander', $ctaPid, $ctaV, 1), strpos(track_url('lander', $ctaPid, $ctaV, 1), '&video_id=')));
check('track url: no &cta= without a mode', !str_contains(track_url('lander', $ctaPid, $ctaV), 'cta='));
check('dot.js: reads &cta=, asks /_dop/cta and sends cta_id', str_contains(TRACKER_DOT_JS, "/[?&]cta=([123])") && str_contains(TRACKER_DOT_JS, "'/_dop/cta?page='") && str_contains(TRACKER_DOT_JS, 'payload.cta_id = ctaId'));
check('dot.js: the test link (&cta=3) asks &preview= at once and never sets cta_id', str_contains(TRACKER_DOT_JS, "'&preview=' + ctaPreview") && str_contains(TRACKER_DOT_JS, 'ctaPending = ctaPreview ? null : c.id') && str_contains(TRACKER_DOT_JS, 'if (ctaMode === 2 || ctaMode === 3)'));
check('dot.js: the CTA is fetched hidden CTA_LEAD (3 s) before the pitch and shown at the pitch; cta_id only from the reveal', str_contains(TRACKER_DOT_JS, 'var CTA_LEAD = 3;') && str_contains(TRACKER_DOT_JS, 't >= p - CTA_LEAD && t < p') && str_contains(TRACKER_DOT_JS, 'if (ctaPending) ctaId = ctaPending;'));
