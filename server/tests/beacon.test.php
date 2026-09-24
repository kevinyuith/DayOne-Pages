<?php
declare(strict_types=1);

// Where the script goes: before the LAST </body> (case-insensitive); without </body>, at the end.
same('before </body>', '<html><body>x' . BEACON_SCRIPT . '</body></html>', beacon_inject('<html><body>x</body></html>'));
same('before the last </BODY>', '<p>"</body>"</p>' . BEACON_SCRIPT . '</BODY>', beacon_inject('<p>"</body>"</p></BODY>'));
same('no </body>: at the end', '<p>x</p>' . BEACON_SCRIPT, beacon_inject('<p>x</p>'));
check('script calls the endpoint on load', str_contains(BEACON_SCRIPT, 'sendBeacon("/_dop/l"') && str_contains(BEACON_SCRIPT, '"load"'));

// Which responses get the load notice: HTML pages.
$html = ['content_type' => 'text/html; charset=utf-8'];
check('html at /', beacon_applies($html, make_request()));
check('html at .php', beacon_applies($html, make_request(['REQUEST_URI' => '/thank-you.php'])));
check('empty content_type = html', beacon_applies(['content_type' => ''], make_request()));
check('no content_type = html', beacon_applies([], make_request()));
check('css: no', !beacon_applies(['content_type' => 'text/css'], make_request(['REQUEST_URI' => '/app.css'])));
check('html served as .txt: no', !beacon_applies($html, make_request(['REQUEST_URI' => '/robots.txt'])));

// Cookie and id.
check('id = 32 hex', preg_match('/^[0-9a-f]{32}$/', beacon_new_visit_id()) === 1);
check('different ids', beacon_new_visit_id() !== beacon_new_visit_id());
same('cookie', 'dop_v=' . str_repeat('a', 32) . '; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax', beacon_cookie(str_repeat('a', 32)));

// POST /_dop/l.
$id = str_repeat('0f', 16);
$post = static fn (string $cookie = '') => make_request(['REQUEST_METHOD' => 'POST', 'REQUEST_URI' => '/_dop/l', 'HTTP_COOKIE' => $cookie]);
[$status, $headers, $body, $visit, $ms] = handle_beacon($post("a=1; dop_v=$id"), 't=812');
same('beacon: 204', 204, $status);
same('beacon: no-store', 'no-store', $headers['Cache-Control'] ?? null);
same('beacon: no body', null, $body);
same('beacon: id from the cookie', $id, $visit);
same('beacon: ms', 812, $ms);
same('beacon without cookie: 204 and nothing to record', [204, null], [handle_beacon($post(), 't=1')[0], handle_beacon($post(), 't=1')[3]]);
same('beacon with invalid cookie: nothing to record', null, handle_beacon($post('dop_v=../x'), 't=1')[3]);
same('beacon with uppercase id: nothing to record', null, handle_beacon($post('dop_v=' . strtoupper($id)), 't=1')[3]);
same('beacon: absurd t becomes null', null, handle_beacon($post("dop_v=$id"), 't=99999999')[4]);
same('beacon: negative t becomes null', null, handle_beacon($post("dop_v=$id"), 't=-5')[4]);
same('beacon: no t, id still counts', [$id, null], array_slice(handle_beacon($post("dop_v=$id"), ''), 3, 2));
same('beacon via GET: 404', 404, handle_beacon(make_request(['REQUEST_URI' => '/_dop/l', 'HTTP_COOKIE' => "dop_v=$id"]), '')[0]);

// serve_slug: HTML gets the script and the ETag gets the version; anything that is not a page stays the same.
$bSlug = '22222222-2222-2222-2222-222222222222';
cache_put_content('bb01', '<html><body>hi</body></html>');
[$status, $headers, $body] = serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/html'], make_request());
same('serve html: body with the script', '<html><body>hi' . BEACON_SCRIPT . '</body></html>', $body);
same('serve html: ETag with version', '"bb01-b2"', $headers['ETag']);
same('serve html: old ETag (no version) → 200', 200, serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/html'], make_request(['HTTP_IF_NONE_MATCH' => '"bb01"']))[0]);
[$status, $headers, $body] = serve_slug(['slug_id' => $bSlug, 'content_hash' => 'bb01', 'content_type' => 'text/css'], make_request(['REQUEST_URI' => '/app.css']));
same('serve css: body untouched', '<html><body>hi</body></html>', $body);
same('serve css: ETag is just the hash', '"bb01"', $headers['ETag']);
