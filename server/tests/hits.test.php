<?php
declare(strict_types=1);

// Quais paths entram em pages.hits: .html, .php ou sem extensão.
check('grava .html', is_logged_path('/oferta.html'));
check('grava .php', is_logged_path('/index.php'));
check('grava .php em subpasta', is_logged_path('/lp/v2/obrigado.php'));
check('grava extensão maiúscula', is_logged_path('/Index.PHP'));
check('grava raiz', is_logged_path('/'));
check('grava sem extensão', is_logged_path('/oferta'));
check('grava subpasta sem extensão', is_logged_path('/lp/oferta'));
check('grava sem extensão com ponto na pasta', is_logged_path('/v1.2/oferta'));
check('não grava .js', !is_logged_path('/app.js'));
check('não grava .env', !is_logged_path('/.env'));
check('não grava .json em subpasta', !is_logged_path('/__/firebase/init.json'));
check('não grava .php.bak', !is_logged_path('/config.php.bak'));
check('não grava .htm', !is_logged_path('/pagina.htm'));
check('não grava .phps', !is_logged_path('/info.phps'));

// ASN (Team Cymru): nome consultado e leitura das respostas TXT, sem rede.
same('cymru ipv4', '8.8.8.8.origin.asn.cymru.com', cymru_origin_name('8.8.8.8'));
same('cymru ipv4 invertido', '163.48.148.34.origin.asn.cymru.com', cymru_origin_name('34.148.48.163'));
same(
    'cymru ipv6',
    '7.7.7.e.b.9.f.2.5.b.7.e.b.4.9.2.1.e.d.8.a.0.1.0.c.4.1.0.4.0.8.2.origin6.asn.cymru.com',
    cymru_origin_name('2804:14c:10a:8de1:294b:e7b5:2f9b:e777'),
);
same('cymru ip privado', null, cymru_origin_name('192.168.0.10'));
same('cymru loopback', null, cymru_origin_name('127.0.0.1'));
same('cymru inválido', null, cymru_origin_name('not-an-ip'));
same('cymru vazio', null, cymru_origin_name(''));

same('origin: asn', 15169, parse_cymru_origin('15169 | 8.8.8.0/24 | US | arin | 2023-12-28'));
same('origin: mais de um asn → primeiro', 15169, parse_cymru_origin('15169 36040 | 8.8.8.0/24 | US | arin | 2023-12-28'));
same('origin: null', null, parse_cymru_origin(null));
same('origin: lixo', null, parse_cymru_origin('NA | x'));
same('origin: zero', null, parse_cymru_origin('0 | 1.2.3.0/24 | ZZ | x | x'));

same('as name', 'GOOGLE-CLOUD-PLATFORM - Google LLC, US', parse_cymru_as_name('396982 | US | arin | 2018-08-15 | GOOGLE-CLOUD-PLATFORM - Google LLC, US'));
same('as name: null', null, parse_cymru_as_name(null));
same('as name: sem campo', null, parse_cymru_as_name('396982 | US | arin'));
same('as name: vazio', null, parse_cymru_as_name('396982 | US | arin | 2018-08-15 |  '));

// Decisão registrada no hit.
same('decisão: nenhuma rota', 'NONE', hit_decision(null));
same('decisão: ação + tipo', 'SERVE · FALLBACK', hit_decision(['action' => 'SERVE', 'match_type' => 'FALLBACK']));
same('decisão: sem tipo', 'REDIRECT', hit_decision(['action' => 'REDIRECT']));

// decide() devolve a rota que decidiu (5º elemento), para o registro.
$human = make_request(['REQUEST_URI' => '/?go=1']);
$crawler = make_request(['HTTP_USER_AGENT' => 'Googlebot/2.1 (+http://www.google.com/bot.html)']);
$redirect = ['route_id' => 'r1', 'priority' => 1, 'match_type' => 'EXACT', 'action' => 'REDIRECT', 'conditions' => ['query' => ['go' => 'present']], 'page_id' => null, 'slug' => null, 'redirect_url' => 'https://x.test/', 'status_code' => 302];
$gate = ['route_id' => null, 'priority' => -1, 'match_type' => 'BOTGATE', 'action' => 'BLOCK', 'conditions' => ['bot' => true], 'status_code' => 403];
same('decide: rota do redirect', 'r1', decide([$redirect], $human)[4]['route_id'] ?? 'nenhuma');
same('decide: bot gate', 'BLOCK · BOTGATE', hit_decision(decide([$gate, $redirect], $crawler)[4]));
same('decide: nenhuma casou', null, decide([$redirect], make_request())[4]);
same('decide: sem rotas', null, decide([], make_request())[4]);

// Host gravado no hit: como o visitante acessou (mantém www), sem porta/ponto final.
same('host visitado: com www', 'www.example.com', visited_host(make_request(['HTTP_HOST' => 'WWW.Example.com:443'])));
same('host visitado: sem www', 'example.com', visited_host(make_request(['HTTP_HOST' => 'example.com.'])));
