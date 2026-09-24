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

same('query without sub0', 'utm=a&b=2', query_without('utm=a&sub0=old&b=2', 'sub0'));
same('query with only sub0', '', query_without('sub0=x&sub0=y', 'sub0'));
same('query keeps sub01 and encoding', 'sub01=x&q=a%20b', query_without('sub01=x&q=a%20b', 'sub0'));
same('empty query', '', query_without('', 'sub0'));
same('inserts before', 'a=1&n=v&sub1=2', query_insert_before('a=1&sub1=2', 'n=v', 'sub1'));
same('inserts at the end without the target', 'a=1&n=v', query_insert_before('a=1', 'n=v', 'sub1'));
same('inserts into an empty query', 'n=v', query_insert_before('', 'n=v', 'sub1'));

// Entry via www.
$serve = ['action' => 'SERVE', 'match_type' => 'FALLBACK', 'route_id' => 'r1'];
$sub0Of = static function (string $location): ?int {
    parse_str((string) parse_url($location, PHP_URL_QUERY), $q);
    return sub0_decrypt((string) ($q['sub0'] ?? ''), 'DAYONE');
};

$r = www_entry_redirect(make_request(['HTTP_HOST' => 'WWW.Example.com', 'REQUEST_URI' => '/Offer?utm_campaign=c1&sub0=old&b=2']), 'served', $serve);
same('www: 302', 302, $r[0] ?? null);
check('www: without www, original path and query, sub0 at the end', str_starts_with($r[1]['Location'] ?? '', 'https://example.com/Offer?utm_campaign=c1&b=2&sub0='), $r[1]['Location'] ?? '');
check('www: sub0 = now', abs(($sub0Of($r[1]['Location'] ?? '') ?? 0) - time()) <= 2);
same('www: sub0 only once', 1, substr_count($r[1]['Location'] ?? '', 'sub0='));
same('www: no-store', 'no-store', $r[1]['Cache-Control'] ?? null);

// Only generates sub0 with a campaign: sub1, utm_campaign or campaign, with a value.
$loc = static fn (string $uri) => www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => $uri]), 'served', $serve)[1]['Location'] ?? '';
same('campaign: sub1 → sub0 before it', 'sub0', explode('=', explode('?', $loc('/?sub1=abc'))[1])[0]);
check('sub0 right before sub1', preg_match('~^https://example\.com/\?utm_source=fb&sub0=[A-Za-z0-9_-]{51}&sub1=abc&sub2=x$~', $loc('/?utm_source=fb&sub1=abc&sub2=x')) === 1, $loc('/?utm_source=fb&sub1=abc&sub2=x'));
check('sub0 before sub1 even with an old sub0 after it', preg_match('~^https://example\.com/\?sub0=[A-Za-z0-9_-]{51}&sub1=abc&x=1$~', $loc('/?sub1=abc&sub0=old&x=1')) === 1, $loc('/?sub1=abc&sub0=old&x=1'));
check('sub0 before uppercase SUB1', preg_match('~\?a=1&sub0=[^&]+&SUB1=z$~', $loc('/?a=1&SUB1=z')) === 1, $loc('/?a=1&SUB1=z'));
check('no sub1: sub0 at the end', preg_match('~\?utm_campaign=c&b=2&sub0=[^&]+$~', $loc('/?utm_campaign=c&b=2')) === 1, $loc('/?utm_campaign=c&b=2'));
check('sub10 does not count as sub1: sub0 at the end', preg_match('~\?campaign=c&sub10=a&sub0=[^&]+$~', $loc('/?campaign=c&sub10=a')) === 1, $loc('/?campaign=c&sub10=a'));
check('campaign: campaign', str_contains($loc('/?x=1&campaign=abc'), '&sub0='));
check('campaign: uppercase name', str_contains($loc('/?UTM_Campaign=abc'), '&sub0='));
check('campaign: encoded value', str_contains($loc('/?utm_campaign=%7Bname%7D'), '&sub0='));
same('no campaign: 302 without sub0, query intact', 'https://example.com/Offer?utm_source=fb&sub0=old', $loc('/Offer?utm_source=fb&sub0=old'));
same('no query: 302 without sub0 and without ?', 'https://example.com/', $loc('/'));
same('empty campaign does not count', 'https://example.com/?utm_campaign=&sub1=', $loc('/?utm_campaign=&sub1='));
same('look-alikes do not count (sub10, my_campaign)', 'https://example.com/?sub10=a&my_campaign=b', $loc('/?sub10=a&my_campaign=b'));

$r = www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com:443', 'REQUEST_URI' => '/?sub1=a']), 'served', $serve);
check('www root, port ignored', preg_match('~^https://example\.com/\?sub0=[A-Za-z0-9_-]{51}&sub1=a$~', $r[1]['Location'] ?? '') === 1, $r[1]['Location'] ?? '');
same('www .html redirects', 302, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/lp.html']), 'served', $serve)[0] ?? null);

same('no www: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'example.com', 'REQUEST_URI' => '/']), 'served', $serve));
same('www blocked: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'blocked', $serve));
same('www bot: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'bot', $serve));
same('www 404: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'notfound', null));
same('www route redirect: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'redirect', $serve));
same('www default robots.txt: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/robots.txt']), 'served', null));
same('www file: passes through', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/app.js']), 'served', $serve));
