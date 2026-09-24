<?php
declare(strict_types=1);

// Onde o script entra: antes do ÚLTIMO </body> (maiúsculas não importam); sem </body>, no fim.
same('antes do </body>', '<html><body>x' . BEACON_SCRIPT . '</body></html>', beacon_inject('<html><body>x</body></html>'));
same('antes do último </BODY>', '<p>"</body>"</p>' . BEACON_SCRIPT . '</BODY>', beacon_inject('<p>"</body>"</p></BODY>'));
same('sem </body>: no fim', '<p>x</p>' . BEACON_SCRIPT, beacon_inject('<p>x</p>'));
check('script chama o endpoint no load', str_contains(BEACON_SCRIPT, 'sendBeacon("/_dop/l"') && str_contains(BEACON_SCRIPT, '"load"'));

// Quais respostas levam o aviso: página HTML.
$html = ['content_type' => 'text/html; charset=utf-8'];
check('html em /', beacon_applies($html, make_request()));
check('html em .php', beacon_applies($html, make_request(['REQUEST_URI' => '/obrigado.php'])));
check('content_type vazio = html', beacon_applies(['content_type' => ''], make_request()));
check('sem content_type = html', beacon_applies([], make_request()));
check('css não', !beacon_applies(['content_type' => 'text/css'], make_request(['REQUEST_URI' => '/app.css'])));
check('html servido como .txt não', !beacon_applies($html, make_request(['REQUEST_URI' => '/robots.txt'])));

// Cookie e id.
check('id = 32 hex', preg_match('/^[0-9a-f]{32}$/', beacon_new_visit_id()) === 1);
check('ids diferentes', beacon_new_visit_id() !== beacon_new_visit_id());
same('cookie', 'dop_v=' . str_repeat('a', 32) . '; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax', beacon_cookie(str_repeat('a', 32)));

// POST /_dop/l.
$id = str_repeat('0f', 16);
$post = static fn (string $cookie = '') => make_request(['REQUEST_METHOD' => 'POST', 'REQUEST_URI' => '/_dop/l', 'HTTP_COOKIE' => $cookie]);
[$status, $headers, $body, $visit, $ms] = handle_beacon($post("a=1; dop_v=$id"), 't=812');
same('beacon: 204', 204, $status);
same('beacon: no-store', 'no-store', $headers['Cache-Control'] ?? null);
same('beacon: sem corpo', null, $body);
same('beacon: id do cookie', $id, $visit);
same('beacon: ms', 812, $ms);
same('beacon sem cookie: 204 e nada a gravar', [204, null], [handle_beacon($post(), 't=1')[0], handle_beacon($post(), 't=1')[3]]);
same('beacon com cookie inválido: nada a gravar', null, handle_beacon($post('dop_v=../x'), 't=1')[3]);
same('beacon com id maiúsculo: nada a gravar', null, handle_beacon($post('dop_v=' . strtoupper($id)), 't=1')[3]);
same('beacon: t absurdo vira null', null, handle_beacon($post("dop_v=$id"), 't=99999999')[4]);
same('beacon: t negativo vira null', null, handle_beacon($post("dop_v=$id"), 't=-5')[4]);
same('beacon: sem t, id vale', [$id, null], array_slice(handle_beacon($post("dop_v=$id"), ''), 3, 2));
same('beacon por GET: 404', 404, handle_beacon(make_request(['REQUEST_URI' => '/_dop/l', 'HTTP_COOKIE' => "dop_v=$id"]), '')[0]);

// serve_slug: HTML ganha o script e o ETag a versão; o que não é página fica igual.
$bSlug = '22222222-2222-2222-2222-222222222222';
cache_put_content($bSlug, 'bb01', '<html><body>oi</body></html>');
[$status, $headers, $body] = serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/html'], make_request());
same('serve html: corpo com o script', '<html><body>oi' . BEACON_SCRIPT . '</body></html>', $body);
same('serve html: ETag com versão', '"bb01-b2"', $headers['ETag']);
same('serve html: ETag velho (sem versão) → 200', 200, serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/html'], make_request(['HTTP_IF_NONE_MATCH' => '"bb01"']))[0]);
[$status, $headers, $body] = serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/css'], make_request(['REQUEST_URI' => '/app.css']));
same('serve css: corpo intacto', '<html><body>oi</body></html>', $body);
same('serve css: ETag só o hash', '"bb01"', $headers['ETag']);
