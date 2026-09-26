<?php
declare(strict_types=1);

$noon = new DateTimeImmutable('2026-09-23 16:00:00', new DateTimeZone('UTC')); // 12:00 in New York
$req = make_request(['REQUEST_URI' => '/presell?utm=1', 'HTTP_ACCEPT_LANGUAGE' => 'pt-BR,pt;q=0.9,en;q=0.8']);

// {{company.name}}: the legal name without the legal suffix. Same cases as the TS side (company-names.json).
foreach (json_decode((string) file_get_contents(__DIR__ . '/company-names.json'), true) as [$legal, $expected]) {
    same('company.name of ' . json_encode($legal, JSON_UNESCAPED_UNICODE), $expected, company_name($legal));
}

// Values: text only, route without placeholders = null, automatic values from the visit.
same('route without placeholders: no replacement', null, placeholder_values(['slug_id' => 'x'], $req, $noon));
$v = placeholder_values([
    'slug' => '/presell',
    'placeholders' => ['company.llc' => 'Acme <Health> LLC', 'company.phone' => '555', 'company.email' => '', 'domain' => 'ex.com', 'bad' => ['x'], 'company.number' => 12345],
], $req, $noon);
same('non-text is left out', false, array_key_exists('bad', $v));
same('number becomes text', '12345', $v['company.number'] ?? null);
same('company.name derived from the legal name', 'Acme <Health>', $v['company.name'] ?? null);
same('url: https + domain + path, no query', 'https://ex.com/presell', $v['url'] ?? null);
same('slug: served path', '/presell', $v['slug'] ?? null);
same('lang: first from Accept-Language', 'pt', $v['lang'] ?? null);
same('language: name in the language itself', 'Português', $v['language'] ?? null);
same('date in Portuguese', '23 de setembro de 2026', $v['date'] ?? null);
same('year', '2026', $v['year'] ?? null);

// Language and date: no header = English; a language without a months table = date in English; unknown code = the code.
$en = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(), $noon);
same('no Accept-Language: en', 'en', $en['lang']);
same('date in English', 'September 23, 2026', $en['date']);
same('English', 'English', $en['language']);
$de = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(['HTTP_ACCEPT_LANGUAGE' => 'de-DE']), $noon);
same('date in German', '23. September 2026', $de['date']);
$ja = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(['HTTP_ACCEPT_LANGUAGE' => 'ja']), $noon);
same('Japanese: name yes, date in English', ['日本語', 'September 23, 2026'], [$ja['language'], $ja['date']]);
$xx = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(['HTTP_ACCEPT_LANGUAGE' => 'xx']), $noon);
same('unknown language: the code', 'xx', $xx['language']);
// The date is New York's: 02:00 UTC on the 24th is still the 23rd there.
$late = placeholder_values(['placeholders' => ['domain' => 'ex.com']], make_request(), new DateTimeImmutable('2026-09-24 02:00:00', new DateTimeZone('UTC')));
same('New York day', 'September 23, 2026', $late['date']);

// Replacement in HTML: dotted keys, escaped, spaces allowed, unknown left intact, empty becomes nothing.
$html = '<p>{{company.name}} · {{ company.phone }} · {{url}} · {{date}} · {{ message }} · {{company.fax}} · <a href="mailto:{{company.email}}">x</a></p>';
same(
    'html: dotted keys, escaped, unknown intact, empty removed',
    '<p>Acme &lt;Health&gt; · 555 · https://ex.com/presell · 23 de setembro de 2026 · {{ message }} · {{company.fax}} · <a href="mailto:">x</a></p>',
    placeholders_apply($html, $v, 'text/html; charset=utf-8'),
);
same('empty content_type = html', 'Acme &lt;Health&gt;', placeholders_apply('{{company.name}}', $v, ''));
same('text/plain: raw', 'Acme <Health>', placeholders_apply('{{company.name}}', $v, 'text/plain; charset=utf-8'));
same('css: untouched', '/* {{company.name}} */', placeholders_apply('/* {{company.name}} */', $v, 'text/css'));
same('no values: body unchanged', '{{company.name}}', placeholders_apply('{{company.name}}', null, 'text/html'));

// ETag: '' without placeholders; changes with domain data, language and day; independent of order.
same('etag without placeholders', '', placeholders_etag(null));
$base = ['placeholders' => ['company.phone' => '1', 'company.email' => 'a@b.c', 'domain' => 'ex.com']];
$a = placeholders_etag(placeholder_values($base, make_request(), $noon));
$b = placeholders_etag(placeholder_values(['placeholders' => ['domain' => 'ex.com', 'company.email' => 'a@b.c', 'company.phone' => '1']], make_request(), $noon));
check('etag -p + 8 hex', preg_match('/^-p[0-9a-f]{8}$/', $a) === 1);
same('etag independent of order', $a, $b);
check('etag changes with the data', $a !== placeholders_etag(placeholder_values(['placeholders' => ['company.phone' => '2'] + $base['placeholders']], make_request(), $noon)));
check('etag changes with the language', $a !== placeholders_etag(placeholder_values($base, make_request(['HTTP_ACCEPT_LANGUAGE' => 'es']), $noon)));
check('etag changes with the day', $a !== placeholders_etag(placeholder_values($base, make_request(), $noon->modify('+1 day'))));

// serve_slug end to end (a domain page: no load notice): replaced body and ETag with the suffix.
$slug = 'ph-test-' . bin2hex(random_bytes(4));
cache_put_content('ph1', '<html><body><h1>{{company.name}}</h1><p>{{lang}}</p></body></html>');
$route = ['slug_id' => $slug, 'content_hash' => 'ph1', 'content_type' => 'text/html; charset=utf-8', 'funnel' => false,
          'placeholders' => ['company.llc' => 'Acme Inc.', 'domain' => 'ex.com']];
[$status, $headers, $body] = serve_slug($route, make_request(['HTTP_ACCEPT_LANGUAGE' => 'es']));
same('serve_slug 200', 200, $status);
check('body with the values', str_contains((string) $body, '<h1>Acme</h1><p>es</p>'));
check('ETag = hash + placeholders', preg_match('/^"ph1-p[0-9a-f]{8}"$/', $headers['ETag']) === 1, $headers['ETag']);
[$status] = serve_slug($route, make_request(['HTTP_ACCEPT_LANGUAGE' => 'es', 'HTTP_IF_NONE_MATCH' => $headers['ETag']]));
same('304 with the same ETag', 304, $status);
[$status] = serve_slug(['placeholders' => ['company.llc' => 'Other LLC', 'domain' => 'ex.com']] + $route, make_request(['HTTP_ACCEPT_LANGUAGE' => 'es', 'HTTP_IF_NONE_MATCH' => $headers['ETag']]));
same('domain data changed → 200', 200, $status);
