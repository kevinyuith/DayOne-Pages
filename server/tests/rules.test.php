<?php
declare(strict_types=1);

// ── The traffic gate, on every path: the rules detect; a clean click on an allowed slug goes to the funnel of its sub1 ──

$domId = '99999999-0000-4000-8000-000000000099';
$pageId = '88888888-0000-4000-8000-000000000088'; // the domain page (has slugs "/" and "/oferta")
$pgA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
$pgB = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// The routes the resolve returns for (host, path): the domain's pages at the requested slug.
$routeAt = fn (string $slug, string $hash): array => [
    'route_id' => null, 'domain_id' => $domId, 'priority' => 0, 'match_type' => 'PAGE',
    'conditions' => [], 'action' => 'SERVE', 'page_id' => $pageId, 'slug' => $slug,
    'slug_id' => '44444444-0000-4000-8000-0000000000aa', 'content_type' => 'text/html; charset=utf-8',
    'content_hash' => $hash, 'preserve_query' => true,
];

$gate = [
    'gate_slugs' => ['/oferta'],
    'rules' => [
        ['name' => 'Datacenter US', 'label' => 'Suspicious', 'reason' => 'Datacenter IP range', 'tags' => [], 'conditions' => ['param' => ['name' => 'net', 'equals' => 'dc']]],
        ['name' => 'Bad UA', 'label' => 'Bot', 'tags' => ['scrape'], 'conditions' => ['user_agent' => 'scraperxyz|evilscraper']],
    ],
    'funnels' => [
        'F23' => [
            'split' => [
                ['page_id' => $pgA, 'content_type' => 'text/html; charset=utf-8', 'content_hash' => 'fade01', 'weight' => 70],
                ['page_id' => $pgB, 'content_type' => 'text/html; charset=utf-8', 'content_hash' => 'fade02', 'weight' => 30],
            ],
            'vsl' => [['id' => str_repeat('a', 24), 'weight' => 100]],
        ],
    ],
];

cache_put_content('home01', '<html><body>HOME</body></html>');
cache_put_content('ofer01', '<html><body>OFERTA</body></html>');
cache_put_content('fade01', '<html><body>F23-A</body></html>');
cache_put_content('fade02', '<html><body>F23-B</body></html>');

$root = [$routeAt('/', 'home01')];
$oferta = [$routeAt('/oferta', 'ofer01')];

// ── A rule matches: the domain's page at the requested slug, with label + rule + tags ──
[$st, , $body, $outcome, $route] = decide($root, make_request(['REQUEST_URI' => '/?net=dc']), $gate);
same('rule match: domain page at /', [200, 'served', 'GATE-SAFE', 'home01'], [$st, $outcome, $route['match_type'], $route['content_hash']]);
same('rule match: detection logged', ['Suspicious', 'Datacenter US', []], [$route['_rule_label'], $route['_rule'], $route['_rule_tags']]);
same('rule match: the reason goes to the log', 'Datacenter IP range', $route['_rule_reason']);
check('rule match: the page HTML', str_contains((string) $body, 'HOME'));

// The first match wins.
[, , , , $route] = decide($root, make_request(['REQUEST_URI' => '/?net=dc', 'HTTP_USER_AGENT' => 'x ScraperXYZ']), $gate);
same('first match wins', ['Suspicious', 'Datacenter US'], [$route['_rule_label'], $route['_rule']]);
// Only the UA rule matches (its tags go along).
[, , , , $route] = decide($root, make_request(['HTTP_USER_AGENT' => 'x EvilScraper']), $gate);
same('UA rule: label + tags', ['Bot', 'Bad UA', ['scrape']], [$route['_rule_label'], $route['_rule'], $route['_rule_tags']]);
same('a rule without a reason logs none', '', $route['_rule_reason']);

// ── Clean, allowed slug ("/" and "/oferta"): the funnel of the sub1's [F23] ──
[$st, $hd, $body, $outcome, $route] = decide($root, make_request(['REQUEST_URI' => '/?sub1=' . rawurlencode('[CA] [FB] [F23] [ABERTO]')]), $gate);
same('clean: served by F23', [200, 'served', 'GATE'], [$st, $outcome, $route['match_type']]);
check('clean: one of F23 pages', in_array($route['content_hash'], ['fade01', 'fade02'], true), (string) $route['content_hash']);
same('clean: funnel code logged', 'F23', $route['_funnel']);
check('clean: no detection', !isset($route['_rule_label']));
check('clean: Set-Cookie dop_pg', str_contains(json_encode($hd['Set-Cookie'] ?? []), 'dop_pg='));
check('clean: vsl carried', ($route['vsl'][0]['id'] ?? null) === str_repeat('a', 24));

// The funnel's main page is served at ANOTHER allowed slug (/oferta), same split.
[, , , , $route] = decide($oferta, make_request(['REQUEST_URI' => '/oferta?sub1=x[F23]']), $gate);
same('clean: F23 at /oferta too', 'GATE', $route['match_type']);
check('clean: F23 page at /oferta', in_array($route['content_hash'], ['fade01', 'fade02'], true));

// ── A slug that is NOT allowed: the domain's page at that slug (not the funnel) ──
[, , $body, , $route] = decide($oferta, make_request(['REQUEST_URI' => '/oferta?sub1=x[F23]']), [...$gate, 'gate_slugs' => []]);
same('not allowed slug: the domain page', ['GATE-SAFE', 'ofer01'], [$route['match_type'], $route['content_hash']]);
check('not allowed: oferta HTML', str_contains((string) $body, 'OFERTA'));
check('not allowed: no funnel mark', !isset($route['_funnel']));

// ── Clean but no [F…] token: the domain's page at "/" ──
[, , , , $route] = decide($root, make_request(['REQUEST_URI' => '/?sub1=plain']), $gate);
same('no token: domain page at /', ['GATE-SAFE', 'home01'], [$route['match_type'], $route['content_hash']]);

// No sub1 at all: the domain's page at "/".
[, , , , $route] = decide($root, make_request(), $gate);
same('no sub1: domain page at /', 'home01', $route['content_hash']);

// A funnel the data doesn't have: the domain's page at "/", code logged.
[, , , , $route] = decide($root, make_request(['REQUEST_URI' => '/?sub1=x[F99]']), $gate);
same('unknown funnel: domain page', 'home01', $route['content_hash']);
same('unknown funnel: code logged', 'F99', $route['_funnel']);

// No rules at all: everything clean → the funnel of the sub1.
[, , , , $route] = decide($root, make_request(['REQUEST_URI' => '/?sub1=x[F23]']), [...$gate, 'rules' => []]);
same('no rules: clean, to the funnel', 'GATE', $route['match_type']);

// No domain page has the requested slug: the gate 404s.
[, , , $outcome, $route] = decide([], make_request(['REQUEST_URI' => '/nix?sub1=x[F23]']), $gate);
same('no page at the slug: 404', [404, 'notfound'], [$outcome === 'notfound' ? 404 : 0, $outcome]);

// No gate data (an old cache): the route loop serves the domain's page.
[, , , , $route] = decide($root, make_request(['REQUEST_URI' => '/?sub1=x[F23]']), null);
same('no gate data: the route loop', 'home01', $route['content_hash']);

// ── gate_slug_allowed / gate_domain_page / gate_funnel_code ──
check('slug allowed: /', gate_slug_allowed('/', []));
check('slug allowed: in the list', gate_slug_allowed('/oferta', ['/oferta']));
check('slug allowed: case-insensitive', gate_slug_allowed('/OFERTA', ['/oferta']));
check('slug not allowed', !gate_slug_allowed('/outra', ['/oferta']));
same('funnel code: [F23]', 'F23', gate_funnel_code('[CA] [FB] [F23]'));
same('funnel code: lowercase', 'F7', gate_funnel_code('x[f7]y'));
same('funnel code: none', null, gate_funnel_code('plain'));

// ── rule_conditions_match ──
$req = make_request(['REQUEST_URI' => '/?' . http_build_query(['sub1' => 'Camp-X', 'sub11' => 'FB', 'net' => 'dc9']), 'HTTP_USER_AGENT' => 'Mozilla Chrome/120', 'HTTP_CF_IPCOUNTRY' => 'br']);
check('sub ids: case-insensitive', rule_conditions_match(['sub1' => 'camp-x', 'sub11' => 'fb'], $req));
check('param equals', rule_conditions_match(['param' => ['name' => 'net', 'equals' => 'DC9']], $req));
check('param contains', rule_conditions_match(['param' => ['name' => 'net', 'contains' => 'dc']], $req));
check('param present', rule_conditions_match(['param' => ['name' => 'net', 'present' => true]], $req));
check('UA regex', rule_conditions_match(['user_agent' => 'chrome'], $req));
check('UA + base', rule_conditions_match(['user_agent' => 'chrome', 'countries' => ['BR']], $req));
check('empty conditions', rule_conditions_match([], $req));

// ── helpers ──
$refs = gate_content_refs($gate);
sort($refs);
same('gate_content_refs', [['page_id' => $pgA, 'slug' => '/'], ['page_id' => $pgB, 'slug' => '/']], $refs);
check('gate_content_ids', gate_content_ids($gate) === ['fade01', 'fade02']);
same('gate_ref_hash', 'fade02', gate_ref_hash($gate, $pgB));
