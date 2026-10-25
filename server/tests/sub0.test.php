<?php
declare(strict_types=1);

// Token: AES-256-GCM, base64url, round trip with the key; anything else → null.
$token = sub0_encrypt(1790000000, 'DAYONE');
same('token decrypts', 1790000000, sub0_decrypt($token, 'DAYONE'));
same('token has 51 characters', 51, strlen($token));
check('token is base64url only', preg_match('/^[A-Za-z0-9_-]+$/', $token) === 1, $token);
check('random nonce: same timestamp, different tokens', $token !== sub0_encrypt(1790000000, 'DAYONE'));
same('another key does not decrypt', null, sub0_decrypt($token, 'OTHER'));
$flip = $token;
$flip[20] = $flip[20] === 'A' ? 'B' : 'A';
same('tampered token does not decrypt', null, sub0_decrypt($flip, 'DAYONE'));
same('truncated token does not decrypt', null, sub0_decrypt(substr($token, 0, 30), 'DAYONE'));
same('garbage does not decrypt', null, sub0_decrypt('abc+/=', 'DAYONE'));
same('empty does not decrypt', null, sub0_decrypt('', 'DAYONE'));
// Decrypts the same way outside PHP: nonce | ciphertext | tag, key sha256("DAYONE").
same(
    'fixed token decrypts',
    1790000000,
    sub0_decrypt(rtrim(strtr(base64_encode(str_repeat("\0", 12) . openssl_encrypt('1790000000', 'aes-256-gcm', hash('sha256', 'DAYONE', true), OPENSSL_RAW_DATA, str_repeat("\0", 12), $tag) . $tag), '+/', '-_'), '='), 'DAYONE'),
);

same('query without sub21', 'utm=a&b=2', query_without('utm=a&sub21=old&b=2', 'sub21'));
same('query with only sub21', '', query_without('sub21=x&sub21=y', 'sub21'));
same('query keeps sub210 and encoding', 'sub210=x&q=a%20b', query_without('sub210=x&q=a%20b', 'sub21'));
same('empty query', '', query_without('', 'sub21'));
same('after the last subN', 'sub1=a&sub11=b&n=v&fbclid=x', query_insert_after_subs('sub1=a&sub11=b&fbclid=x', 'n=v'));
same('after the last subN, wherever it is', 'sub3=a&x=1&SUB11=b&n=v', query_insert_after_subs('sub3=a&x=1&SUB11=b', 'n=v'));
same('no subN: at the end', 'a=1&subid=2&n=v', query_insert_after_subs('a=1&subid=2', 'n=v'));
same('inserts into an empty query', 'n=v', query_insert_after_subs('', 'n=v'));

// Entry via www.
$serve = ['action' => 'SERVE', 'match_type' => 'FALLBACK', 'route_id' => 'r1'];
$tokenOf = static function (string $location): ?int {
    parse_str((string) parse_url($location, PHP_URL_QUERY), $q);
    return sub0_decrypt((string) ($q['sub21'] ?? ''), 'DAYONE');
};

$r = www_entry_redirect(make_request(['HTTP_HOST' => 'WWW.Example.com', 'REQUEST_URI' => '/Offer?sub1=c1&sub21=old&sub11=Facebook&fbclid=IwAB&b=2']), 'served', $serve);
same('www: 302', 302, $r[0] ?? null);
check('www: without www, original path and query, sub21 after the last subN', preg_match('~^https://example\.com/Offer\?sub1=c1&sub11=Facebook&sub21=[A-Za-z0-9_-]{51}&fbclid=IwAB&b=2$~', $r[1]['Location'] ?? '') === 1, $r[1]['Location'] ?? '');
check('www: sub21 = now', abs(($tokenOf($r[1]['Location'] ?? '') ?? 0) - time()) <= 2);
same('www: sub21 only once', 1, substr_count($r[1]['Location'] ?? '', 'sub21='));
same('www: no-store', 'no-store', $r[1]['Cache-Control'] ?? null);
check('www: dop_www stays 30 days in the browser (the rule counts its own days)', str_contains($r[1]['Set-Cookie'][0] ?? '', 'Max-Age=2592000'));
// The entry's cookie, on the bare domain: the sub21 that went into the URL.
parse_str((string) parse_url($r[1]['Location'] ?? '', PHP_URL_QUERY), $q);
same('www: cookie = the sub21, on the bare domain and its subdomains', ['dop_www=' . ($q['sub21'] ?? '') . '; Domain=example.com; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax'], $r[1]['Set-Cookie'] ?? null);
same('www without fbclid: cookie = 1', 'dop_www=1; Domain=example.com', implode(';', array_slice(explode(';', (www_entry_redirect(make_request(['HTTP_HOST' => 'www.Example.com', 'REQUEST_URI' => '/?sub1=a&utm_campaign=c']), 'served', $serve)[1]['Set-Cookie'][0] ?? '')), 0, 2)));

// Only an fbclid (with a value) makes the token.
$loc = static fn (string $uri) => www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => $uri]), 'served', $serve)[1]['Location'] ?? '';
check('fbclid without subN: sub21 at the end', preg_match('~\?utm_source=fb&fbclid=IwAB&sub21=[A-Za-z0-9_-]{51}$~', $loc('/?utm_source=fb&fbclid=IwAB')) === 1, $loc('/?utm_source=fb&fbclid=IwAB'));
check('fbclid: any case', str_contains($loc('/?FBCLID=IwAB'), '&sub21='));
check('fbclid: sub21 after sub10, not sub1', preg_match('~\?sub1=a&sub10=b&sub21=[^&]+&x=1&fbclid=Iw$~', $loc('/?sub1=a&sub10=b&x=1&fbclid=Iw')) === 1, $loc('/?sub1=a&sub10=b&x=1&fbclid=Iw'));
same('campaign without fbclid: no sub21, query intact', 'https://example.com/?sub1=abc&utm_campaign=c&sub21=old', $loc('/?sub1=abc&utm_campaign=c&sub21=old'));
same('no query: 302 without sub21 and without ?', 'https://example.com/', $loc('/'));
same('empty fbclid does not count', 'https://example.com/?fbclid=&sub1=a', $loc('/?fbclid=&sub1=a'));
same('look-alikes do not count (my_fbclid)', 'https://example.com/?my_fbclid=b', $loc('/?my_fbclid=b'));

$r = www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com:443', 'REQUEST_URI' => '/?sub1=a&fbclid=Iw']), 'served', $serve);
check('www root, port ignored', preg_match('~^https://example\.com/\?sub1=a&sub21=[A-Za-z0-9_-]{51}&fbclid=Iw$~', $r[1]['Location'] ?? '') === 1, $r[1]['Location'] ?? '');
same('www .html redirects', 302, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/lp.html']), 'served', $serve)[0] ?? null);

same('no www: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'example.com', 'REQUEST_URI' => '/']), 'served', $serve));
same('www blocked: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'blocked', $serve));
same('www bot: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'bot', $serve));
same('www 404: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'notfound', null));
same('www route redirect: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'redirect', $serve));
same('www default robots.txt: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/robots.txt']), 'served', null));
same('www file: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/app.js']), 'served', $serve));

// The www entry on the bare domain, with the owner's numbers (token 4 h, cookie 5 days):
// a dop_www token at most 5 days old (any click's), or the URL's own sub21 at most
// 4 hours old (another browser/device).
$now = 1790000000;
$H = 4 * 3600;
$D = 5 * 86400;
$tok = static fn (int $ago): string => sub0_encrypt($now - $ago, 'DAYONE');
$bare = static fn (string $query, ?string $cookie = null, string $host = 'example.com'): Request => make_request(array_filter([
    'HTTP_HOST' => $host,
    'REQUEST_URI' => '/' . ($query !== '' ? "?$query" : ''),
    'HTTP_COOKIE' => $cookie !== null ? WWW_COOKIE . '=' . $cookie : null,
], static fn ($v) => $v !== null));
check('www entry: www. itself is the entry', www_entry_valid($bare('fbclid=x', null, 'www.example.com'), $H, $D, $now));
check('www entry: this click\'s cookie', www_entry_valid($bare('sub21=' . ($t = $tok(3600)), $t), $H, $D, $now));
check('www entry: another click\'s cookie, 4 days old', www_entry_valid($bare('sub21=' . $tok(10 * 86400), $tok(4 * 86400)), $H, $D, $now));
check('www entry: cookie over 5 days old and an old sub21', !www_entry_valid($bare('sub21=' . $tok(6 * 86400), $tok(5 * 86400 + 1)), $H, $D, $now));
check('www entry: the rule\'s cookie_days decide (10 days)', www_entry_valid($bare('sub21=' . $tok(9 * 86400), $tok(9 * 86400)), $H, 10 * 86400, $now));
check('www entry: cookie_days 0 = the cookie never counts', !www_entry_valid($bare('sub21=' . $tok(5 * 3600), $tok(3600)), $H, 0, $now));
check('www entry: no cookie, sub21 3 hours old (another device)', www_entry_valid($bare('fbclid=y&sub21=' . $tok(3 * 3600)), $H, $D, $now));
check('www entry: no cookie, sub21 exactly 4 hours old', www_entry_valid($bare('sub21=' . $tok(4 * 3600)), $H, $D, $now));
check('www entry: no cookie, sub21 over 4 hours old', !www_entry_valid($bare('sub21=' . $tok(4 * 3600 + 1)), $H, $D, $now));
check('www entry: the rule\'s token_hours decide (24 h)', www_entry_valid($bare('sub21=' . $tok(20 * 3600)), 24 * 3600, $D, $now));
check('www entry: an expired cookie falls back to a fresh sub21', www_entry_valid($bare('sub21=' . $tok(600), $tok(6 * 86400)), $H, $D, $now));
check('www entry: no cookie, no sub21', !www_entry_valid($bare('fbclid=z'), $H, $D, $now));
check('www entry: dop_www=1 (no fbclid) has no time', !www_entry_valid($bare('fbclid=z', '1'), $H, $D, $now));
check('www entry: a tampered sub21', !www_entry_valid($bare('sub21=' . substr($tok(60), 0, -2) . 'AA'), $H, $D, $now));
check('www entry: a sub21 from the future', !www_entry_valid($bare('sub21=' . $tok(-3600)), $H, $D, $now));
check('www entry: SUB21 in any case', www_entry_valid($bare('SUB21=' . $tok(60)), $H, $D, $now));

// The browser that came in on a sub21 within the window inherits it as its dop_www.
$t = $tok(1800);
same('inherit: fresh sub21, no cookie → the sub21 as dop_www', www_cookie('example.com', $t), www_inherit_cookie($bare("sub21=$t"), $H, $now));
same('inherit: an older click\'s cookie is replaced', www_cookie('example.com', $t), www_inherit_cookie($bare("sub21=$t", $tok(86400)), $H, $now));
same('inherit: this click\'s cookie stays', null, www_inherit_cookie($bare("sub21=$t", $t), $H, $now));
same('inherit: a newer click\'s cookie stays', null, www_inherit_cookie($bare("sub21=$t", $tok(60)), $H, $now));
same('inherit: dop_www=1 is replaced', www_cookie('example.com', $t), www_inherit_cookie($bare("sub21=$t", '1'), $H, $now));
same('inherit: sub21 outside the window never renews a cookie', null, www_inherit_cookie($bare('sub21=' . $tok(5 * 3600)), $H, $now));
same('inherit: not on www.', null, www_inherit_cookie($bare("sub21=$t", null, 'www.example.com'), $H, $now));
same('inherit: no sub21', null, www_inherit_cookie($bare('fbclid=x'), $H, $now));

// The window comes from the gate's rules that check the entry (the longest token_hours).
same('window: no rule checks the entry', null, www_entry_window(['rules' => [['conditions' => ['prefetch' => true]]]]));
same('window: the longest token_hours, Monitor rules included', 6 * 3600, www_entry_window([
    'rules' => [['conditions' => ['www_entry' => ['token_hours' => 4, 'cookie_days' => 5]]]],
    'monitor_rules' => [['conditions' => ['www_entry' => ['token_hours' => 6, 'cookie_days' => 5]]]],
]));
same('window: no gate', null, www_entry_window(null));
