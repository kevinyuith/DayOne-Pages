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

check('vazio casa sempre', conditions_match([], $desktop));
check('chave desconhecida não casa', !conditions_match(['foo' => 1], $desktop));

check('país casa', conditions_match(['countries' => ['BR']], $br));
check('país minúsculo na regra casa', conditions_match(['countries' => ['br']], $br));
check('país não casa', !conditions_match(['countries' => ['US']], $br));
check('sem header de país não casa', !conditions_match(['countries' => ['BR']], $desktop));

// countries_mode = block: inverte. País na lista não casa; fora dela casa.
check('país block: na lista não casa', !conditions_match(['countries' => ['BR'], 'countries_mode' => 'block'], $br));
check('país block: fora da lista casa', conditions_match(['countries' => ['US'], 'countries_mode' => 'block'], $br));
check('país block: sem país casa (nada a barrar)', conditions_match(['countries' => ['BR'], 'countries_mode' => 'block'], $desktop));

same('device desktop', 'desktop', device_from_ua($desktop->userAgent));
same('device mobile', 'mobile', device_from_ua($mobile->userAgent));
same('device tablet ipad', 'tablet', device_from_ua($tablet->userAgent));
same('device tablet android', 'tablet', device_from_ua($androidTablet->userAgent));
check('devices casa mobile', conditions_match(['devices' => ['mobile']], $mobile));
check('devices não casa desktop', !conditions_match(['devices' => ['mobile']], $desktop));

same('accept-language parseado', ['pt', 'en'], languages_from_header('pt-BR,pt;q=0.9,en;q=0.8'));
same('accept-language vazio', [], languages_from_header(''));
check('idioma allow casa en', conditions_match(['languages' => ['en']], $enUs));
check('idioma allow não casa es', !conditions_match(['languages' => ['es']], $enUs));
check('idioma allow casa idioma secundário', conditions_match(['languages' => ['en']], $ptBr));
check('idioma allow sem header não casa', !conditions_match(['languages' => ['en']], $noLang));
check('idioma block: na lista não casa', !conditions_match(['languages' => ['en'], 'languages_mode' => 'block'], $enUs));
check('idioma block: fora da lista casa', conditions_match(['languages' => ['es'], 'languages_mode' => 'block'], $enUs));
check('idioma block: sem header casa (nada a barrar)', conditions_match(['languages' => ['en'], 'languages_mode' => 'block'], $noLang));

check('query present casa', conditions_match(['query' => ['utm_source' => 'present']], $withQuery));
check('query present não casa', !conditions_match(['query' => ['utm_source' => 'present']], $desktop));
check('query absent casa', conditions_match(['query' => ['gclid' => 'absent']], $desktop));
check('query absent não casa', !conditions_match(['query' => ['gclid' => 'absent']], $withQuery));
check('query equals casa', conditions_match(['query' => ['utm_source' => ['equals' => 'tiktok']]], $withQuery));
check('query equals não casa', !conditions_match(['query' => ['utm_source' => ['equals' => 'meta']]], $withQuery));
check('query regra inválida não casa', !conditions_match(['query' => ['x' => 'maybe']], $withQuery));

check('referrer casa', conditions_match(['referrer' => 'facebook.com'], $fromFb));
check('referrer case-insensitive', conditions_match(['referrer' => 'FACEBOOK'], $fromFb));
check('referrer não casa', !conditions_match(['referrer' => 'tiktok'], $fromFb));
check('referrer ausente não casa', !conditions_match(['referrer' => 'x'], $desktop));

check('bot casa googlebot', conditions_match(['bot' => true], $bot));
check('bot casa sem UA', conditions_match(['bot' => true], $noUa));
check('bot não casa navegador', !conditions_match(['bot' => true], $desktop));
check('bot false nunca casa', !conditions_match(['bot' => false], $bot));

check('combinação: país + device', conditions_match(['countries' => ['BR'], 'devices' => ['desktop']], $br));
check('combinação: falha numa falha tudo', !conditions_match(['countries' => ['BR'], 'devices' => ['mobile']], $br));

// decide(): rotas com bot fora de BLOCK são ignoradas; primeira que casa vence.
$routes = [
    ['route_id' => 'a', 'priority' => 1, 'action' => 'SERVE', 'conditions' => ['bot' => true], 'page_id' => 'p', 'slug' => '/', 'slug_id' => 'x', 'content_hash' => 'h'],
    ['route_id' => 'b', 'priority' => 2, 'action' => 'BLOCK', 'conditions' => ['bot' => true], 'status_code' => 403],
    ['route_id' => 'c', 'priority' => 3, 'action' => 'REDIRECT', 'conditions' => ['query' => ['go' => 'present']], 'redirect_url' => 'https://x.test/y?z=1', 'status_code' => 302, 'preserve_query' => true],
    ['route_id' => null, 'priority' => PHP_INT_MAX, 'match_type' => 'FALLBACK', 'action' => 'SERVE', 'conditions' => [], 'page_id' => 'p', 'slug' => '/', 'slug_id' => null],
];
[$status] = decide($routes, $bot);
same('bot: SERVE com bot ignorada, BLOCK 403 vence', 403, $status);
[$status, $headers] = decide($routes, make_request(['REQUEST_URI' => '/?go=1&utm=2']));
same('redirect 302', 302, $status);
same('redirect mantém query', 'https://x.test/y?z=1&go=1&utm=2', $headers['Location']);
[$status] = decide($routes, $desktop);
same('fallback com slug_id nulo → 404', 404, $status);
[$status, $headers, $body] = decide([], make_request(['REQUEST_URI' => '/robots.txt']));
same('robots.txt padrão', 200, $status);
check('robots.txt corpo', str_contains((string) $body, 'User-agent'));

// Bot gate do domínio (block_bots): BLOCK 403 no topo, só casa bot; humano segue.
$gate = [
    ['route_id' => null, 'priority' => -1, 'match_type' => 'BOTGATE', 'action' => 'BLOCK', 'conditions' => ['bot' => true], 'status_code' => 403],
    ['route_id' => null, 'priority' => PHP_INT_MAX, 'match_type' => 'FALLBACK', 'action' => 'SERVE', 'conditions' => [], 'page_id' => 'p', 'slug' => '/', 'slug_id' => null],
];
same('bot gate bloqueia bot', 403, decide($gate, $bot)[0]);
same('bot gate deixa humano seguir (fallback 404)', 404, decide($gate, $desktop)[0]);
