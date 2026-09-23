<?php
declare(strict_types=1);

// Token: AES-256-GCM, base64url, ida e volta com a chave; qualquer outra coisa → null.
$token = sub0_encrypt(1790000000, 'DAYONE');
same('token decifra', 1790000000, sub0_decrypt($token, 'DAYONE'));
same('token tem 51 caracteres', 51, strlen($token));
check('token só base64url', preg_match('/^[A-Za-z0-9_-]+$/', $token) === 1, $token);
check('nonce aleatório: mesmo timestamp, tokens diferentes', $token !== sub0_encrypt(1790000000, 'DAYONE'));
same('outra chave não decifra', null, sub0_decrypt($token, 'OUTRA'));
$flip = $token;
$flip[20] = $flip[20] === 'A' ? 'B' : 'A';
same('token adulterado não decifra', null, sub0_decrypt($flip, 'DAYONE'));
same('token cortado não decifra', null, sub0_decrypt(substr($token, 0, 30), 'DAYONE'));
same('lixo não decifra', null, sub0_decrypt('abc+/=', 'DAYONE'));
same('vazio não decifra', null, sub0_decrypt('', 'DAYONE'));
// Decifra igual fora do PHP: nonce | cifrado | tag, chave sha256("DAYONE").
same(
    'token fixo decifra',
    1790000000,
    sub0_decrypt(rtrim(strtr(base64_encode(str_repeat("\0", 12) . openssl_encrypt('1790000000', 'aes-256-gcm', hash('sha256', 'DAYONE', true), OPENSSL_RAW_DATA, str_repeat("\0", 12), $tag) . $tag), '+/', '-_'), '='), 'DAYONE'),
);

same('query sem sub0', 'utm=a&b=2', query_without('utm=a&sub0=velho&b=2', 'sub0'));
same('query só com sub0', '', query_without('sub0=x&sub0=y', 'sub0'));
same('query mantém sub01 e codificação', 'sub01=x&q=a%20b', query_without('sub01=x&q=a%20b', 'sub0'));
same('query vazia', '', query_without('', 'sub0'));
same('insere antes', 'a=1&n=v&sub1=2', query_insert_before('a=1&sub1=2', 'n=v', 'sub1'));
same('insere no fim sem o alvo', 'a=1&n=v', query_insert_before('a=1', 'n=v', 'sub1'));
same('insere em query vazia', 'n=v', query_insert_before('', 'n=v', 'sub1'));

// Entrada por www.
$serve = ['action' => 'SERVE', 'match_type' => 'FALLBACK', 'route_id' => 'r1'];
$sub0Of = static function (string $location): ?int {
    parse_str((string) parse_url($location, PHP_URL_QUERY), $q);
    return sub0_decrypt((string) ($q['sub0'] ?? ''), 'DAYONE');
};

$r = www_entry_redirect(make_request(['HTTP_HOST' => 'WWW.Example.com', 'REQUEST_URI' => '/Oferta?utm_campaign=c1&sub0=velho&b=2']), 'served', $serve);
same('www: 302', 302, $r[0] ?? null);
check('www: sem www, path e query originais, sub0 no fim', str_starts_with($r[1]['Location'] ?? '', 'https://example.com/Oferta?utm_campaign=c1&b=2&sub0='), $r[1]['Location'] ?? '');
check('www: sub0 = agora', abs(($sub0Of($r[1]['Location'] ?? '') ?? 0) - time()) <= 2);
same('www: sub0 só uma vez', 1, substr_count($r[1]['Location'] ?? '', 'sub0='));
same('www: no-store', 'no-store', $r[1]['Cache-Control'] ?? null);

// Só gera sub0 com campanha: sub1, utm_campaign ou campaign, com valor.
$loc = static fn (string $uri) => www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => $uri]), 'served', $serve)[1]['Location'] ?? '';
same('campanha: sub1 → sub0 antes dele', 'sub0', explode('=', explode('?', $loc('/?sub1=abc'))[1])[0]);
check('sub0 logo antes do sub1', preg_match('~^https://example\.com/\?utm_source=fb&sub0=[A-Za-z0-9_-]{51}&sub1=abc&sub2=x$~', $loc('/?utm_source=fb&sub1=abc&sub2=x')) === 1, $loc('/?utm_source=fb&sub1=abc&sub2=x'));
check('sub0 antes do sub1 mesmo com sub0 velho depois', preg_match('~^https://example\.com/\?sub0=[A-Za-z0-9_-]{51}&sub1=abc&x=1$~', $loc('/?sub1=abc&sub0=velho&x=1')) === 1, $loc('/?sub1=abc&sub0=velho&x=1'));
check('sub0 antes do SUB1 maiúsculo', preg_match('~\?a=1&sub0=[^&]+&SUB1=z$~', $loc('/?a=1&SUB1=z')) === 1, $loc('/?a=1&SUB1=z'));
check('sem sub1: sub0 no fim', preg_match('~\?utm_campaign=c&b=2&sub0=[^&]+$~', $loc('/?utm_campaign=c&b=2')) === 1, $loc('/?utm_campaign=c&b=2'));
check('sub10 não conta como sub1: sub0 no fim', preg_match('~\?campaign=c&sub10=a&sub0=[^&]+$~', $loc('/?campaign=c&sub10=a')) === 1, $loc('/?campaign=c&sub10=a'));
check('campanha: campaign', str_contains($loc('/?x=1&campaign=abc'), '&sub0='));
check('campanha: nome em maiúsculas', str_contains($loc('/?UTM_Campaign=abc'), '&sub0='));
check('campanha: valor codificado', str_contains($loc('/?utm_campaign=%7Bnome%7D'), '&sub0='));
same('sem campanha: 302 sem sub0, query intacta', 'https://example.com/Oferta?utm_source=fb&sub0=velho', $loc('/Oferta?utm_source=fb&sub0=velho'));
same('sem query: 302 sem sub0 e sem ?', 'https://example.com/', $loc('/'));
same('campanha vazia não conta', 'https://example.com/?utm_campaign=&sub1=', $loc('/?utm_campaign=&sub1='));
same('parecido não conta (sub10, my_campaign)', 'https://example.com/?sub10=a&my_campaign=b', $loc('/?sub10=a&my_campaign=b'));

$r = www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com:443', 'REQUEST_URI' => '/?sub1=a']), 'served', $serve);
check('www raiz, porta ignorada', preg_match('~^https://example\.com/\?sub0=[A-Za-z0-9_-]{51}&sub1=a$~', $r[1]['Location'] ?? '') === 1, $r[1]['Location'] ?? '');
same('www .html redireciona', 302, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/lp.html']), 'served', $serve)[0] ?? null);

same('sem www: segue', null, www_entry_redirect(make_request(['HTTP_HOST' => 'example.com', 'REQUEST_URI' => '/']), 'served', $serve));
same('www bloqueado: segue', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'blocked', $serve));
same('www bot: segue', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'bot', $serve));
same('www 404: segue', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'notfound', null));
same('www redirect de rota: segue', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com']), 'redirect', $serve));
same('www robots.txt padrão: segue', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/robots.txt']), 'served', null));
same('www arquivo: segue', null, www_entry_redirect(make_request(['HTTP_HOST' => 'www.example.com', 'REQUEST_URI' => '/app.js']), 'served', $serve));
