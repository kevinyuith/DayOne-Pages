<?php
declare(strict_types=1);

// ── handlers.php: /_purge with the token, or signed for one host (09/10) ──

$token = 'test-purge-token';
$now = time();
$sign = static fn(string $host, int $t, string $key = 'test-purge-token'): string => hash_hmac('sha256', "$host|$t", $key);

check('signature: valid', purge_signature_ok('example.com', (string) $now, $sign('example.com', $now), $token, $now));
check('signature: uppercase hex is the same', purge_signature_ok('example.com', (string) $now, strtoupper($sign('example.com', $now)), $token, $now));
check('signature: another token → no', !purge_signature_ok('example.com', (string) $now, $sign('example.com', $now, 'other'), $token, $now));
check('signature: another host → no', !purge_signature_ok('other.com', (string) $now, $sign('example.com', $now), $token, $now));
check('signature: 121 s old → no', !purge_signature_ok('example.com', (string) ($now - 121), $sign('example.com', $now - 121), $token, $now));
check('signature: 121 s ahead → no', !purge_signature_ok('example.com', (string) ($now + 121), $sign('example.com', $now + 121), $token, $now));
check('signature: 119 s old → yes (the two clocks)', purge_signature_ok('example.com', (string) ($now - 119), $sign('example.com', $now - 119), $token, $now));
check('signature: time not a number → no', !purge_signature_ok('example.com', 'abc', $sign('example.com', $now), $token, $now));
check('signature: no token configured → no', !purge_signature_ok('example.com', (string) $now, hash_hmac('sha256', "example.com|$now", ''), '', $now));

$post = static fn(array $headers): Request => make_request(['REQUEST_METHOD' => 'POST', 'HTTP_HOST' => 'purge.example', 'REQUEST_URI' => '/_purge'] + $headers);
$signed = static fn(string $host, int $t): array => ['HTTP_X_PURGE_SIGNATURE' => $sign($host, $t), 'HTTP_X_PURGE_TIME' => (string) $t];

cache_put_routes('purge.example', '/', [['route_id' => 'p1', 'action' => 'SERVE', 'slug_id' => 's', 'content_hash' => 'x', 'conditions' => []]]);
[$st, , $body] = handle_purge($post($signed('purge.example', $now)), '{"host":"purge.example"}');
same('signed purge: 200', 200, $st);
check('signed purge: the host entry is gone', cache_get_routes('purge.example', '/')['state'] === 'NONE', (string) $body);
same('signed purge, www. in the body: the same host', 200, handle_purge($post($signed('purge.example', $now)), '{"host":"www.purge.example"}')[0]);
same('signed for one host, another in the body: 404', 404, handle_purge($post($signed('purge.example', $now)), '{"host":"other.example"}')[0]);
same('signed: "all" needs the token itself → 404', 404, handle_purge($post($signed('purge.example', $now)), '{"all":true}')[0]);
same('signed, invalid body: 404 (nothing confirmed)', 404, handle_purge($post($signed('purge.example', $now)), 'not json')[0]);
same('expired signature: 404', 404, handle_purge($post($signed('purge.example', $now - 300)), '{"host":"purge.example"}')[0]);
same('no token, no signature: 404', 404, handle_purge($post([]), '{"host":"purge.example"}')[0]);
same('the token: still 200', 200, handle_purge($post(['HTTP_X_PURGE_TOKEN' => $token]), '{"host":"purge.example"}')[0]);
same('the token, invalid body: 400', 400, handle_purge($post(['HTTP_X_PURGE_TOKEN' => $token]), 'not json')[0]);
same('a wrong token: 404', 404, handle_purge($post(['HTTP_X_PURGE_TOKEN' => 'nope']), '{"host":"purge.example"}')[0]);
same('GET: 404', 404, handle_purge(make_request(['REQUEST_URI' => '/_purge'] + $signed('purge.example', $now)), '{"host":"purge.example"}')[0]);
