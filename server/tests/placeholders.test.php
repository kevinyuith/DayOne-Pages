<?php
declare(strict_types=1);

$noon = new DateTimeImmutable('2026-09-23 16:00:00', new DateTimeZone('UTC')); // 12:00 em Nova York
$req = make_request(['REQUEST_URI' => '/pressel?utm=1', 'HTTP_ACCEPT_LANGUAGE' => 'pt-BR,pt;q=0.9,en;q=0.8']);

// {{company.name}}: razão social sem o sufixo jurídico. Mesmos casos do lado TS (company-names.json).
foreach (json_decode((string) file_get_contents(__DIR__ . '/company-names.json'), true) as [$legal, $expected]) {
    same('company.name de ' . json_encode($legal, JSON_UNESCAPED_UNICODE), $expected, company_name($legal));
}

// Valores: só texto, rota sem marcadores = null, automáticos da visita.
same('rota sem placeholders: não troca', null, placeholder_values(['slug_id' => 'x'], $req, $noon));
$v = placeholder_values([
    'slug' => '/pressel',
    'placeholders' => ['company.llc' => 'Acme <Health> LLC', 'company.phone' => '555', 'company.email' => '', 'domain' => 'ex.com', 'bad' => ['x'], 'company.number' => 12345],
], $req, $noon);
same('não-texto fica de fora', false, array_key_exists('bad', $v));
same('número vira texto', '12345', $v['company.number'] ?? null);
same('company.name calculado da razão social', 'Acme <Health>', $v['company.name'] ?? null);
same('url: https + domínio + path, sem query', 'https://ex.com/pressel', $v['url'] ?? null);
same('slug: path servido', '/pressel', $v['slug'] ?? null);
same('lang: primeiro do Accept-Language', 'pt', $v['lang'] ?? null);
same('language: nome no próprio idioma', 'Português', $v['language'] ?? null);
same('date em português', '23 de setembro de 2026', $v['date'] ?? null);
same('year', '2026', $v['year'] ?? null);

// Idioma e data: sem header = inglês; idioma sem tabela de meses = data em inglês; código desconhecido = o código.
$en = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(), $noon);
same('sem Accept-Language: en', 'en', $en['lang']);
same('date em inglês', 'September 23, 2026', $en['date']);
same('English', 'English', $en['language']);
$de = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(['HTTP_ACCEPT_LANGUAGE' => 'de-DE']), $noon);
same('date em alemão', '23. September 2026', $de['date']);
$ja = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(['HTTP_ACCEPT_LANGUAGE' => 'ja']), $noon);
same('japonês: nome sim, data em inglês', ['日本語', 'September 23, 2026'], [$ja['language'], $ja['date']]);
$xx = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(['HTTP_ACCEPT_LANGUAGE' => 'xx']), $noon);
same('idioma desconhecido: o código', 'xx', $xx['language']);
// A data é a de Nova York: 02:00 UTC do dia 24 ainda é dia 23 lá.
$late = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(), new DateTimeImmutable('2026-09-24 02:00:00', new DateTimeZone('UTC')));
same('dia de Nova York', 'September 23, 2026', $late['date']);

// Troca no HTML: chaves com ponto, escapado, espaços valem, desconhecida intacta, vazio vira nada.
$html = '<p>{{company.name}} · {{ company.phone }} · {{url}} · {{date}} · {{ message }} · {{company.fax}} · <a href="mailto:{{company.email}}">x</a></p>';
same(
    'html: chaves com ponto, escapado, desconhecidas intactas, vazio some',
    '<p>Acme &lt;Health&gt; · 555 · https://ex.com/pressel · 23 de setembro de 2026 · {{ message }} · {{company.fax}} · <a href="mailto:">x</a></p>',
    placeholders_apply($html, $v, 'text/html; charset=utf-8'),
);
same('content_type vazio = html', 'Acme &lt;Health&gt;', placeholders_apply('{{company.name}}', $v, ''));
same('text/plain: cru', 'Acme <Health>', placeholders_apply('{{company.name}}', $v, 'text/plain; charset=utf-8'));
same('css: não mexe', '/* {{company.name}} */', placeholders_apply('/* {{company.name}} */', $v, 'text/css'));
same('sem valores: corpo igual', '{{company.name}}', placeholders_apply('{{company.name}}', null, 'text/html'));

// ETag: '' sem marcadores; muda com dado do domínio, idioma e dia; não depende da ordem.
same('etag sem marcadores', '', placeholders_etag(null));
$base = ['placeholders' => ['company.phone' => '1', 'company.email' => 'a@b.c', 'domain' => 'ex.com']];
$a = placeholders_etag(placeholder_values($base, make_request(), $noon));
$b = placeholders_etag(placeholder_values(['placeholders' => ['domain' => 'ex.com', 'company.email' => 'a@b.c', 'company.phone' => '1']], make_request(), $noon));
check('etag -p + 8 hex', preg_match('/^-p[0-9a-f]{8}$/', $a) === 1);
same('etag não depende da ordem', $a, $b);
check('etag muda com o dado', $a !== placeholders_etag(placeholder_values(['placeholders' => ['company.phone' => '2'] + $base['placeholders']], make_request(), $noon)));
check('etag muda com o idioma', $a !== placeholders_etag(placeholder_values($base, make_request(['HTTP_ACCEPT_LANGUAGE' => 'es']), $noon)));
check('etag muda com o dia', $a !== placeholders_etag(placeholder_values($base, make_request(), $noon->modify('+1 day'))));

// serve_slug de ponta a ponta: corpo trocado e ETag com o sufixo, antes do -b2 do aviso.
$slug = 'ph-test-' . bin2hex(random_bytes(4));
cache_put_content($slug, 'ph1', '<html><body><h1>{{company.name}}</h1><p>{{lang}}</p></body></html>');
$route = ['slug_id' => $slug, 'content_hash' => 'ph1', 'content_type' => 'text/html; charset=utf-8', 'funnel' => false,
          'placeholders' => ['company.llc' => 'Acme Inc.', 'domain' => 'ex.com']];
[$status, $headers, $body] = serve_slug($route, make_request(['HTTP_ACCEPT_LANGUAGE' => 'es']));
same('serve_slug 200', 200, $status);
check('corpo com os valores', str_contains((string) $body, '<h1>Acme</h1><p>es</p>'));
check('ETag = hash + marcadores + aviso', preg_match('/^"ph1-p[0-9a-f]{8}' . preg_quote(BEACON_ETAG, '/') . '"$/', $headers['ETag']) === 1);
[$status] = serve_slug($route, make_request(['HTTP_ACCEPT_LANGUAGE' => 'es', 'HTTP_IF_NONE_MATCH' => $headers['ETag']]));
same('304 com o mesmo ETag', 304, $status);
[$status] = serve_slug(['placeholders' => ['company.llc' => 'Outra LLC', 'domain' => 'ex.com']] + $route, make_request(['HTTP_ACCEPT_LANGUAGE' => 'es', 'HTTP_IF_NONE_MATCH' => $headers['ETag']]));
same('dado do domínio mudou → 200', 200, $status);
