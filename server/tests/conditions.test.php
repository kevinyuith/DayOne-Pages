<?php
declare(strict_types=1);

$desktop = make_request();
$mobile = make_request(['HTTP_USER_AGENT' => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1']);
$tablet = make_request(['HTTP_USER_AGENT' => 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15']);
$androidTablet = make_request(['HTTP_USER_AGENT' => 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Chrome/120 Safari/537.36']);
$bot = make_request(['HTTP_USER_AGENT' => 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)']);
$noUa = make_request(['HTTP_USER_AGENT' => '']);
$br = make_request(['HTTP_CF_IPCOUNTRY' => 'br']);
$withQuery = make_request(['REQUEST_URI' => '/?utm_source=tiktok&gclid=abc']);
$fromFb = make_request(['HTTP_REFERER' => 'https://l.facebook.com/l.php?u=x']);
$enUs = make_request(['HTTP_ACCEPT_LANGUAGE' => 'en-US,en;q=0.9']);
$ptBr = make_request(['HTTP_ACCEPT_LANGUAGE' => 'pt-BR,pt;q=0.9,en;q=0.8']);
$noLang = make_request(['HTTP_ACCEPT_LANGUAGE' => '']);

check('empty always matches', conditions_match([], $desktop));
check('unknown key does not match', !conditions_match(['foo' => 1], $desktop));

check('country matches', conditions_match(['countries' => ['BR']], $br));
check('lowercase country in the rule matches', conditions_match(['countries' => ['br']], $br));
check('country does not match', !conditions_match(['countries' => ['US']], $br));
check('no country header does not match', !conditions_match(['countries' => ['BR']], $desktop));

// countries_mode = block: inverts. A country in the list does not match; one outside it does.
check('country block: in the list does not match', !conditions_match(['countries' => ['BR'], 'countries_mode' => 'block'], $br));
check('country block: outside the list matches', conditions_match(['countries' => ['US'], 'countries_mode' => 'block'], $br));
check('country block: no country matches (nothing to block)', conditions_match(['countries' => ['BR'], 'countries_mode' => 'block'], $desktop));

same('device desktop', 'desktop', device_from_ua($desktop->userAgent));
same('device mobile', 'mobile', device_from_ua($mobile->userAgent));
same('device tablet ipad', 'tablet', device_from_ua($tablet->userAgent));
same('device tablet android', 'tablet', device_from_ua($androidTablet->userAgent));
check('devices matches mobile', conditions_match(['devices' => ['mobile']], $mobile));
check('devices does not match desktop', !conditions_match(['devices' => ['mobile']], $desktop));

same('accept-language parsed', ['pt', 'en'], languages_from_header('pt-BR,pt;q=0.9,en;q=0.8'));
same('accept-language empty', [], languages_from_header(''));
check('language allow matches en', conditions_match(['languages' => ['en']], $enUs));
check('language allow does not match es', !conditions_match(['languages' => ['es']], $enUs));
check('language allow matches a secondary language', conditions_match(['languages' => ['en']], $ptBr));
check('language allow without header does not match', !conditions_match(['languages' => ['en']], $noLang));
check('language block: in the list does not match', !conditions_match(['languages' => ['en'], 'languages_mode' => 'block'], $enUs));
check('language block: outside the list matches', conditions_match(['languages' => ['es'], 'languages_mode' => 'block'], $enUs));
check('language block: no header matches (nothing to block)', conditions_match(['languages' => ['en'], 'languages_mode' => 'block'], $noLang));

check('query present matches', conditions_match(['query' => ['utm_source' => 'present']], $withQuery));
check('query present does not match', !conditions_match(['query' => ['utm_source' => 'present']], $desktop));
check('query absent matches', conditions_match(['query' => ['gclid' => 'absent']], $desktop));
check('query absent does not match', !conditions_match(['query' => ['gclid' => 'absent']], $withQuery));
check('query equals matches', conditions_match(['query' => ['utm_source' => ['equals' => 'tiktok']]], $withQuery));
check('query equals does not match', !conditions_match(['query' => ['utm_source' => ['equals' => 'meta']]], $withQuery));
check('query invalid rule does not match', !conditions_match(['query' => ['x' => 'maybe']], $withQuery));

check('referrer matches', conditions_match(['referrer' => 'facebook.com'], $fromFb));
check('referrer case-insensitive', conditions_match(['referrer' => 'FACEBOOK'], $fromFb));
check('referrer does not match', !conditions_match(['referrer' => 'tiktok'], $fromFb));
check('missing referrer does not match', !conditions_match(['referrer' => 'x'], $desktop));

check('bot matches googlebot', conditions_match(['bot' => true], $bot));
check('bot matches with no UA', conditions_match(['bot' => true], $noUa));
check('bot does not match a browser', !conditions_match(['bot' => true], $desktop));
check('bot false never matches', !conditions_match(['bot' => false], $bot));

check('combination: country + device', conditions_match(['countries' => ['BR'], 'devices' => ['desktop']], $br));
check('combination: one failure fails all', !conditions_match(['countries' => ['BR'], 'devices' => ['mobile']], $br));

// decide(): routes with bot outside BLOCK are ignored; the first match wins.
$routes = [
    ['route_id' => 'a', 'priority' => 1, 'action' => 'SERVE', 'conditions' => ['bot' => true], 'page_id' => 'p', 'slug' => '/', 'slug_id' => 'x', 'content_hash' => 'h'],
    ['route_id' => 'b', 'priority' => 2, 'action' => 'BLOCK', 'conditions' => ['bot' => true], 'status_code' => 403],
    ['route_id' => 'c', 'priority' => 3, 'action' => 'REDIRECT', 'conditions' => ['query' => ['go' => 'present']], 'redirect_url' => 'https://x.test/y?z=1', 'status_code' => 302, 'preserve_query' => true],
    ['route_id' => null, 'priority' => PHP_INT_MAX, 'match_type' => 'FALLBACK', 'action' => 'SERVE', 'conditions' => [], 'page_id' => 'p', 'slug' => '/', 'slug_id' => null],
];
[$status] = decide($routes, $bot);
same('bot: SERVE with bot ignored, BLOCK 403 wins', 403, $status);
[$status, $headers] = decide($routes, make_request(['REQUEST_URI' => '/?go=1&utm=2']));
same('redirect 302', 302, $status);
same('redirect keeps query', 'https://x.test/y?z=1&go=1&utm=2', $headers['Location']);
[$status] = decide($routes, $desktop);
same('fallback with null slug_id → 404', 404, $status);
[$status, $headers, $body] = decide([$routes[2]], make_request(['REQUEST_URI' => '/robots.txt']));
same('default robots.txt', 200, $status);
check('robots.txt body', str_contains((string) $body, 'User-agent'));
// No routes at all = paused/unknown domain: 404 for everything, even robots.txt.
same('domain without routes: robots.txt 404', 404, decide([], make_request(['REQUEST_URI' => '/robots.txt']))[0]);
same('domain without routes: / 404', 404, decide([], make_request(['REQUEST_URI' => '/']))[0]);

// Domain bot gate (block_bots): BLOCK 403 on top, matches bots only; humans go through.
$gate = [
    ['route_id' => null, 'priority' => -1, 'match_type' => 'BOTGATE', 'action' => 'BLOCK', 'conditions' => ['bot' => true], 'status_code' => 403],
    ['route_id' => null, 'priority' => PHP_INT_MAX, 'match_type' => 'FALLBACK', 'action' => 'SERVE', 'conditions' => [], 'page_id' => 'p', 'slug' => '/', 'slug_id' => null],
];
same('bot gate blocks bot', 403, decide($gate, $bot)[0]);
same('bot gate lets humans through (fallback 404)', 404, decide($gate, $desktop)[0]);
