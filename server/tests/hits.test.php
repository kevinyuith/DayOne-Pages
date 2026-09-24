<?php
declare(strict_types=1);

// Which paths go into pages.hits: .html, .php or no extension.
check('logs .html', is_logged_path('/offer.html'));
check('logs .php', is_logged_path('/index.php'));
check('logs .php in a subfolder', is_logged_path('/lp/v2/thank-you.php'));
check('logs an uppercase extension', is_logged_path('/Index.PHP'));
check('logs the root', is_logged_path('/'));
check('logs no extension', is_logged_path('/offer'));
check('logs a subfolder without extension', is_logged_path('/lp/offer'));
check('logs no extension with a dot in the folder', is_logged_path('/v1.2/offer'));
check('does not log .js', !is_logged_path('/app.js'));
check('does not log .env', !is_logged_path('/.env'));
check('does not log .json in a subfolder', !is_logged_path('/__/firebase/init.json'));
check('does not log .php.bak', !is_logged_path('/config.php.bak'));
check('does not log .htm', !is_logged_path('/page.htm'));
check('does not log .phps', !is_logged_path('/info.phps'));

// ASN (Team Cymru): the queried name and parsing of the TXT answers, no network.
same('cymru ipv4', '8.8.8.8.origin.asn.cymru.com', cymru_origin_name('8.8.8.8'));
same('cymru ipv4 reversed', '163.48.148.34.origin.asn.cymru.com', cymru_origin_name('34.148.48.163'));
same(
    'cymru ipv6',
    '7.7.7.e.b.9.f.2.5.b.7.e.b.4.9.2.1.e.d.8.a.0.1.0.c.4.1.0.4.0.8.2.origin6.asn.cymru.com',
    cymru_origin_name('2804:14c:10a:8de1:294b:e7b5:2f9b:e777'),
);
same('cymru private ip', null, cymru_origin_name('192.168.0.10'));
same('cymru loopback', null, cymru_origin_name('127.0.0.1'));
same('cymru invalid', null, cymru_origin_name('not-an-ip'));
same('cymru empty', null, cymru_origin_name(''));

same('origin: asn', 15169, parse_cymru_origin('15169 | 8.8.8.0/24 | US | arin | 2023-12-28'));
same('origin: more than one asn → first', 15169, parse_cymru_origin('15169 36040 | 8.8.8.0/24 | US | arin | 2023-12-28'));
same('origin: null', null, parse_cymru_origin(null));
same('origin: garbage', null, parse_cymru_origin('NA | x'));
same('origin: zero', null, parse_cymru_origin('0 | 1.2.3.0/24 | ZZ | x | x'));

same('as name', 'GOOGLE-CLOUD-PLATFORM - Google LLC, US', parse_cymru_as_name('396982 | US | arin | 2018-08-15 | GOOGLE-CLOUD-PLATFORM - Google LLC, US'));
same('as name: null', null, parse_cymru_as_name(null));
same('as name: missing field', null, parse_cymru_as_name('396982 | US | arin'));
same('as name: empty', null, parse_cymru_as_name('396982 | US | arin | 2018-08-15 |  '));

// Decision recorded in the hit.
same('decision: no route', 'NONE', hit_decision(null));
same('decision: action + type', 'SERVE · FALLBACK', hit_decision(['action' => 'SERVE', 'match_type' => 'FALLBACK']));
same('decision: no type', 'REDIRECT', hit_decision(['action' => 'REDIRECT']));

// decide() returns the route that decided (5th element), for the log.
$human = make_request(['REQUEST_URI' => '/?go=1']);
$crawler = make_request(['HTTP_USER_AGENT' => 'Googlebot/2.1 (+http://www.google.com/bot.html)']);
$redirect = ['route_id' => 'r1', 'priority' => 1, 'match_type' => 'EXACT', 'action' => 'REDIRECT', 'conditions' => ['query' => ['go' => 'present']], 'page_id' => null, 'slug' => null, 'redirect_url' => 'https://x.test/', 'status_code' => 302];
$gate = ['route_id' => null, 'priority' => -1, 'match_type' => 'BOTGATE', 'action' => 'BLOCK', 'conditions' => ['bot' => true], 'status_code' => 403];
same('decide: redirect route', 'r1', decide([$redirect], $human)[4]['route_id'] ?? 'none');
same('decide: bot gate', 'BLOCK · BOTGATE', hit_decision(decide([$gate, $redirect], $crawler)[4]));
same('decide: none matched', null, decide([$redirect], make_request())[4]);
same('decide: no routes', null, decide([], make_request())[4]);

// Host recorded in the hit: as the visitor typed it (keeps www), without port/trailing dot.
same('visited host: with www', 'www.example.com', visited_host(make_request(['HTTP_HOST' => 'WWW.Example.com:443'])));
same('visited host: without www', 'example.com', visited_host(make_request(['HTTP_HOST' => 'example.com.'])));
