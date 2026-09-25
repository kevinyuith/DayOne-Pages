<?php
declare(strict_types=1);

// ── A/B test between the pages of a funnel (split_pick + decide) ──

$pA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
$pB = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
$other = '33333333-cccc-4ccc-8ccc-cccccccccccc';
$splitRoute = [
    'action' => 'SERVE', 'match_type' => 'FALLBACK', 'conditions' => [], 'page_id' => $pA, 'slug' => '/',
    'slug_id' => '44444444-0000-4000-8000-00000000000a', 'content_hash' => 'hashA', 'content_type' => 'text/html', 'funnel' => false,
    'split' => [
        ['page_id' => $pA, 'slug_id' => '44444444-0000-4000-8000-00000000000a', 'content_hash' => 'hashA', 'content_type' => 'text/html', 'weight' => 70, 'funnel' => false],
        ['page_id' => $pB, 'slug_id' => '44444444-0000-4000-8000-00000000000b', 'content_hash' => 'hashB', 'content_type' => 'text/html', 'weight' => 30, 'funnel' => false],
    ],
];
$fixed = static fn (int $n) => static fn (int $max): int => min($n, $max - 1);

[$r, $ck] = split_pick(['action' => 'SERVE', 'page_id' => $pA, 'slug_id' => 'x'], []);
check('no split: same route, no cookie', $r === ['action' => 'SERVE', 'page_id' => $pA, 'slug_id' => 'x'] && $ck === null);

[$r, $ck] = split_pick($splitRoute, [], $fixed(0));
same('draw 0 of 100 → A (weight 70)', [$pA, 'hashA', $pA], [$r['page_id'], $r['content_hash'], $ck]);
check('chosen route without the split list', !isset($r['split']) && ($r['split_count'] ?? 0) === 2);
[$r, $ck] = split_pick($splitRoute, [], $fixed(85));
same('draw 85 of 100 → B (weight 30), B\'s slug_id', [$pB, '44444444-0000-4000-8000-00000000000b', 'hashB'], [$r['page_id'], $r['slug_id'], $r['content_hash']]);

[$r, $ck] = split_pick($splitRoute, ['dop_pg' => $pB], $fixed(0));
same('cookie wins: a visitor who got B stays on B', $pB, $r['page_id']);
same('same cookie: not sent again', null, $ck);
[$r, $ck] = split_pick($splitRoute, ['dop_pg' => "$other,$pB"], $fixed(0));
same('ids from other funnels stay in the cookie, this one first', "$pB,$other", $ck);
same('malformed cookie: draws again', $pA, split_pick($splitRoute, ['dop_pg' => '<x>'], $fixed(0))[0]['page_id']);

$paused = $splitRoute;
$paused['split'][1]['weight'] = 0;
same('weight 0 = paused: not even visitors who had it stay on it', $pA, split_pick($paused, ['dop_pg' => $pB], $fixed(99))[0]['page_id']);
$zeros = $splitRoute;
$zeros['split'][0]['weight'] = 0;
$zeros['split'][1]['weight'] = 0;
same('all 0: equal shares (draw 1 of 2 → B)', $pB, split_pick($zeros, [], $fixed(1))[0]['page_id']);

$a = 0;
for ($i = 0; $i < 10000; $i++) {
    if (split_pick($splitRoute, [])[0]['page_id'] === $pA) {
        $a++;
    }
}
check('10k draws: ~70% on A', $a > 6700 && $a < 7300, "A=$a");
same('cookie header', "dop_pg=$pA; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax", split_cookie($pA));

// decide: serves the drawn page (its content), Vary Cookie, Set-Cookie dop_pg, returned route = the chosen one (goes to the log).
cache_put_content('hashA', '<html><body>PAGE-A</body></html>');
cache_put_content('hashB', '<html><body>PAGE-B</body></html>');
[$status, $headers, $body, $outcome, $route] = decide([$splitRoute], make_request(['HTTP_COOKIE' => "dop_pg=$pB"]));
same('decide: 200 served', [200, 'served'], [$status, $outcome]);
check('decide: page B\'s body', str_contains((string) $body, 'PAGE-B') && !str_contains((string) $body, 'PAGE-A'));
same('decide: logged route = page B', $pB, $route['page_id']);
check('decide: Vary with Cookie', str_contains($headers['Vary'], 'Cookie'));
check('decide: correct cookie, no Set-Cookie dop_pg', !str_contains(json_encode($headers['Set-Cookie'] ?? []), 'dop_pg'));
same('decide: page B\'s ETag', '"hashB-b3"', $headers['ETag']);
[$status, $headers] = decide([$splitRoute], make_request());
check('decide: new visitor gets Set-Cookie dop_pg', str_contains(json_encode($headers['Set-Cookie'] ?? []), 'dop_pg='), json_encode($headers['Set-Cookie'] ?? null));

// cache: split without content in the stored routes; the check asks for the content of every page.
$withContent = $splitRoute;
$withContent['split'][0]['content'] = 'x';
$withContent['split'][1]['content'] = 'y';
$stripped = strip_content([$withContent]);
check('strip_content removes the content of the split pages', !isset($stripped[0]['split'][0]['content']) && !isset($stripped[0]['split'][1]['content']));
check('cache_has_all_content: has both pages', cache_has_all_content([$splitRoute]));
$missing = $splitRoute;
$missing['split'][1]['content_hash'] = 'missing';
check('cache_has_all_content: a split page is missing → false', !cache_has_all_content([$missing]));

// Load notice: click.
$vid = str_repeat('ab', 16);
$post = static fn () => make_request(['REQUEST_METHOD' => 'POST', 'REQUEST_URI' => '/_dop/l', 'HTTP_COOKIE' => "dop_v=$vid"]);
same('beacon c=1: click', [$vid, 'click'], [handle_beacon($post(), 'c=1')[3], handle_beacon($post(), 'c=1')[4]['kind']]);
same('beacon t=…: load, no click', [$vid, 'load'], [handle_beacon($post(), 't=900')[3], handle_beacon($post(), 't=900')[4]['kind']]);
check('script sends c=1 on a click that leaves the page and ignores "#"', str_contains(BEACON_SCRIPT, 'b("c=1")') && str_contains(BEACON_SCRIPT, 'h.charAt(0)==="#"'));
