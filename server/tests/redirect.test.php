<?php
declare(strict_types=1);

// ── Funnel redirect entry: the split can hold a redirect (302 to a URL template) ──

// funnel_redirect_url: {name} filled from the query (URL-encoded); ONLY the template, nothing appended.
same('a placeholder is filled from the query', 'https://o.com/?c=123', funnel_redirect_url('https://o.com/?c={sub1}', 'sub1=123&x=9'));
same('several placeholders', 'https://o.com/?u=123&t=abc', funnel_redirect_url('https://o.com/?u={sub1}&t={ttclid}', 'ttclid=abc&sub1=123'));
same('a missing param becomes empty', 'https://o.com/?c=', funnel_redirect_url('https://o.com/?c={sub1}', 'other=1'));
same('the value is URL-encoded', 'https://o.com/?c=a%20b%26c', funnel_redirect_url('https://o.com/?c={sub1}', 'sub1=' . rawurlencode('a b&c')));
same('no placeholder: the template as is', 'https://o.com/fixed', funnel_redirect_url('https://o.com/fixed', 'sub1=123'));
same('ONLY the template (no passthrough of extra params)', 'https://o.com/?c=123', funnel_redirect_url('https://o.com/?c={sub1}', 'sub1=123&fbclid=xyz&gclid=q'));
same('an unclosed brace is left alone', 'https://o.com/?c={sub', funnel_redirect_url('https://o.com/?c={sub', 'sub=1'));

// ── decide() end to end: the gate serves a funnel whose entry is a redirect ──
$domId = '99999999-0000-4000-8000-0000000000d1';
$domPage = '88888888-0000-4000-8000-0000000000d1';
$routeAt = fn (string $hash): array => [
    'route_id' => null, 'domain_id' => $domId, 'priority' => 0, 'match_type' => 'PAGE', 'conditions' => [], 'action' => 'SERVE',
    'page_id' => $domPage, 'slug' => '/', 'slug_id' => '44444444-0000-4000-8000-0000000000d1',
    'content_type' => 'text/html; charset=utf-8', 'content_hash' => $hash, 'preserve_query' => true,
];
cache_put_content('rdsafe', '<html><body>SAFE</body></html>');
cache_put_content('rdland', '<html><body><section data-dop-page="p_a" data-dop-kind="main">LANDER</section></body></html>');
$root = [$routeAt('rdsafe')];
$redir = fn (string $url, int $w): array => ['page_id' => '1111redirbbbb4bbb8bbbaaaaaaaaaaaa', 'content_type' => 'text/x-redirect', 'content_hash' => 'x', 'weight' => $w, 'redirect' => $url];
$page = fn (int $w): array => ['page_id' => '2222bbbbbbbb4bbb8bbbcccccccccccc', 'content_type' => 'text/html; charset=utf-8', 'content_hash' => 'rdland', 'weight' => $w, 'redirect' => null];

// One redirect entry: any clean click on the funnel 302s to the templated URL.
$gate1 = ['gate_slugs' => ['/'], 'rules' => [], 'funnels' => ['F50' => ['split' => [$redir('https://offer.com/?utm_campaign={sub1}', 100)]]]];
[$st, $hd, $body, $outcome, $route] = decide($root, make_request(['REQUEST_URI' => '/?sub1=x%5BF50%5D&camp=CAMP']), $gate1);
same('redirect: 302 outcome', [302, 'redirect'], [$st, $outcome]);
same('redirect: Location is the template filled from the query', 'https://offer.com/?utm_campaign=x%5BF50%5D', $hd['Location']);
same('redirect: empty body', '', $body);
same('redirect: logged as a REDIRECT of the gate', 'REDIRECT', $route['action']);
same('redirect: the hit keeps the redirect page id', '1111redirbbbb4bbb8bbbaaaaaaaaaaaa', $route['page_id']);
check('redirect: no beacon/tracker in a 302', !str_contains((string) $body, 'data-dop'));

// Split of a redirect (100%) and a page (0%): the redirect wins.
$gate2 = ['gate_slugs' => ['/'], 'rules' => [], 'funnels' => ['F51' => ['split' => [$redir('https://go.com/?s={sub1}', 100), $page(0)]]]];
[$st2, $hd2, , $oc2] = decide($root, make_request(['REQUEST_URI' => '/?sub1=abc%5BF51%5D']), $gate2);
same('split redirect vs paused page → the redirect', [302, 'redirect', 'https://go.com/?s=abc%5BF51%5D'], [$st2, $oc2, $hd2['Location']]);
check('split redirect: Vary by Cookie and sticky dop_pg', str_contains((string) ($hd2['Vary'] ?? ''), 'Cookie') && str_contains(json_encode($hd2['Set-Cookie'] ?? []), 'dop_pg='));

// Split of a page (100%) and a redirect (0%): the page is served, no stale redirect.
$gate3 = ['gate_slugs' => ['/'], 'rules' => [], 'funnels' => ['F52' => ['split' => [$page(100), $redir('https://no.com/', 0)]]]];
[$st3, , $body3, $oc3, $route3] = decide($root, make_request(['REQUEST_URI' => '/?sub1=x%5BF52%5D']), $gate3);
same('split page vs paused redirect → the page is served', [200, 'served'], [$st3, $oc3]);
check('split page: the lander HTML, not a redirect', str_contains((string) $body3, 'LANDER') && ($route3['action'] ?? '') === 'SERVE');
