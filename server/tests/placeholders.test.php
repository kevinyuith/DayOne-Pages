<?php
declare(strict_types=1);

// Valores: só texto, year automático, rota sem marcadores = null.
same('rota sem placeholders: não troca', null, placeholder_values(['slug_id' => 'x']));
$values = placeholder_values(['placeholders' => ['company_name' => 'Acme <LLC>', 'phone' => '555', 'domain' => 'ex.com', 'bad' => ['x'], 'zip_code' => 78701]]);
same('year automático', gmdate('Y'), $values['year'] ?? null);
same('não-texto fica de fora', false, array_key_exists('bad', $values));
same('número vira texto', '78701', $values['zip_code'] ?? null);

// Troca no HTML: escapado, espaços valem, chave desconhecida intacta, vazio vira nada.
$html = '<p>{{company_name}} · {{ phone }} · {{domain}} · © {{year}} · {{ message }} · <a href="mailto:{{email}}">x</a></p>';
$v = placeholder_values(['placeholders' => ['company_name' => 'Acme <LLC>', 'phone' => '555', 'domain' => 'ex.com', 'email' => '']]);
same(
    'html: escapado, desconhecido intacto, vazio some',
    '<p>Acme &lt;LLC&gt; · 555 · ex.com · © ' . gmdate('Y') . ' · {{ message }} · <a href="mailto:">x</a></p>',
    placeholders_apply($html, $v, 'text/html; charset=utf-8'),
);
same('content_type vazio = html', 'Acme &lt;LLC&gt;', placeholders_apply('{{company_name}}', $v, ''));
same('text/plain: cru', 'Acme <LLC>', placeholders_apply('{{company_name}}', $v, 'text/plain; charset=utf-8'));
same('css: não mexe', '/* {{company_name}} */', placeholders_apply('/* {{company_name}} */', $v, 'text/css'));
same('aspas escapadas', '&quot;&#039;', placeholders_apply('{{q}}', placeholder_values(['placeholders' => ['q' => '"\'']]), 'text/html'));
same('sem valores: corpo igual', '{{company_name}}', placeholders_apply('{{company_name}}', null, 'text/html'));

// ETag: '' sem marcadores; muda quando um valor muda; igual para os mesmos valores em outra ordem.
same('etag sem marcadores', '', placeholders_etag(null));
$a = placeholders_etag(placeholder_values(['placeholders' => ['phone' => '1', 'email' => 'a@b.c']]));
$b = placeholders_etag(placeholder_values(['placeholders' => ['email' => 'a@b.c', 'phone' => '1']]));
$c = placeholders_etag(placeholder_values(['placeholders' => ['phone' => '2', 'email' => 'a@b.c']]));
check('etag -p + 8 hex', preg_match('/^-p[0-9a-f]{8}$/', $a) === 1);
same('etag não depende da ordem', $a, $b);
check('etag muda com o valor', $a !== $c);

// serve_slug de ponta a ponta: corpo trocado e ETag com o sufixo, antes do -b1 do aviso.
$slug = 'ph-test-' . bin2hex(random_bytes(4));
cache_put_content($slug, 'ph1', '<html><body><h1>{{company_name}}</h1></body></html>');
$route = ['slug_id' => $slug, 'content_hash' => 'ph1', 'content_type' => 'text/html; charset=utf-8', 'funnel' => false,
          'placeholders' => ['company_name' => 'Acme', 'domain' => 'ex.com']];
[$status, $headers, $body] = serve_slug($route, make_request());
same('serve_slug 200', 200, $status);
check('corpo com o valor', str_contains((string) $body, '<h1>Acme</h1>'));
$ptag = placeholders_etag(placeholder_values($route));
same('ETag = hash + marcadores + aviso', '"ph1' . $ptag . BEACON_ETAG . '"', $headers['ETag']);
[$status] = serve_slug($route, make_request(['HTTP_IF_NONE_MATCH' => $headers['ETag']]));
same('304 com o mesmo ETag', 304, $status);
[$status] = serve_slug(['placeholders' => ['company_name' => 'Outra', 'domain' => 'ex.com']] + $route, make_request(['HTTP_IF_NONE_MATCH' => $headers['ETag']]));
same('dado do domínio mudou → 200', 200, $status);
