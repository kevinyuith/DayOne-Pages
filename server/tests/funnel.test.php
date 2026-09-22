<?php
declare(strict_types=1);

$doc = static fn (string $bodyAttrs, string $body) => "<!doctype html>\n<html><head><title>t</title><style>x</style></head><body$bodyAttrs>$body<script data-dop-runtime>(function(){})();</script></body></html>";

$sections = '<section data-dop-page="p_pre" data-dop-name="Presell" data-dop-kind="presell" data-dop-start><main><h1>Presell</h1><section class="inner">aninhada</section><a href="#next-step">Continuar</a></main></section>'
    . '<section data-dop-page="p_vsl" data-dop-name="VSL" data-dop-kind="main" hidden=""><h1>VSL</h1></section>'
    . '<section data-dop-page="p_br" data-dop-name="Volta" data-dop-kind="backredirect" data-dop-trigger="back exit" hidden><h1>Volta</h1></section>';

$browser = $doc('', $sections);
$server = $doc(' data-dop-funnel="server"', $sections);

check('modo navegador: não mexe', funnel_apply($browser, []) === null);
check('uma etapa só: não mexe', funnel_apply($doc(' data-dop-funnel="server"', '<section data-dop-page="p_a" data-dop-start>a</section>'), []) === null);

$secs = funnel_sections($server);
same('acha 3 seções de etapa (ignora a aninhada)', ['p_pre', 'p_vsl', 'p_br'], array_column($secs, 'id'));
same('kind e trigger lidos', ['backredirect', 'back exit'], [$secs[2]['kind'], $secs[2]['trigger']]);

$r = funnel_apply($server, []);
same('sem cookie: serve a inicial', 'p_pre', $r['step']);
check('sem cookie: a VSL não sai no HTML', !str_contains($r['html'], 'VSL'));
check('sem cookie: a back redirect não sai', !str_contains($r['html'], 'Volta'));
check('sem cookie: a presell sai inteira (com a seção aninhada)', str_contains($r['html'], 'aninhada') && str_contains($r['html'], 'Continuar'));
check('head e runtime preservados', str_contains($r['html'], '<style>x</style>') && str_contains($r['html'], 'data-dop-runtime'));
check('body recebe cur/next/main/start/br', preg_match('/<body data-dop-funnel="server" data-dop-cur="p_pre" data-dop-start="p_pre" data-dop-next="p_vsl" data-dop-main="p_vsl" data-dop-br="p_br" data-dop-br-trigger="back exit">/', $r['html']) === 1, substr($r['html'], 0, 300));

$r = funnel_apply($server, ['dop_step' => 'p_vsl']);
same('cookie: serve a VSL', 'p_vsl', $r['step']);
check('cookie: a VSL vem sem hidden', preg_match('/<section data-dop-page="p_vsl"[^>]*>/', $r['html'], $m) === 1 && !str_contains($m[0], 'hidden'), $m[0] ?? '');
check('cookie: a presell não sai', !str_contains($r['html'], 'Presell'));
check('cookie: VSL é a última do fluxo → sem next', !str_contains($r['html'], 'data-dop-next='));

$r = funnel_apply($server, ['dop_step' => 'p_br']);
same('cookie: serve a back redirect', 'p_br', $r['step']);
check('back redirect: next é a principal', str_contains($r['html'], 'data-dop-next="p_vsl"'));

same('cookie inválido: cai na inicial', 'p_pre', funnel_apply($server, ['dop_step' => 'p_nope'])['step']);
same('cookie malformado: cai na inicial', 'p_pre', funnel_apply($server, ['dop_step' => '<script>'])['step']);

// serve_slug: ETag por etapa e Vary por Cookie; 304 só bate com a mesma etapa.
$tmpSlug = '11111111-1111-1111-1111-111111111111';
cache_put_content($tmpSlug, 'abc123', $server);
$route = ['slug_id' => $tmpSlug, 'content_hash' => 'abc123', 'content_type' => 'text/html; charset=utf-8'];
[$status, $headers, $body] = serve_slug($route, make_request([]));
same('serve_slug 200 na inicial', 200, $status);
same('ETag com a etapa', '"abc123-p_pre"', $headers['ETag']);
check('Vary inclui Cookie', str_contains($headers['Vary'], 'Cookie'));
check('corpo só com a presell', str_contains((string) $body, 'Presell') && !str_contains((string) $body, 'VSL'));
[$status] = serve_slug($route, make_request(['HTTP_IF_NONE_MATCH' => '"abc123-p_pre"']));
same('304 na mesma etapa', 304, $status);
[$status, $headers] = serve_slug($route, make_request(['HTTP_IF_NONE_MATCH' => '"abc123-p_pre"', 'HTTP_COOKIE' => 'dop_step=p_vsl']));
same('etapa diferente com ETag antigo → 200', 200, $status);
same('ETag da nova etapa', '"abc123-p_vsl"', $headers['ETag']);
cache_put_content($tmpSlug, 'def456', $browser);
[$status, $headers] = serve_slug(['slug_id' => $tmpSlug, 'content_hash' => 'def456', 'content_type' => ''], make_request([]));
same('modo navegador: ETag só o hash', '"def456"', $headers['ETag']);
check('modo navegador: Vary sem Cookie', !str_contains($headers['Vary'], 'Cookie'));
// Marca "funnel=false" no cache de rotas: 304 sem ler o conteúdo (o arquivo pode até sumir).
$flagged = ['slug_id' => $tmpSlug, 'content_hash' => 'ghost99', 'content_type' => '', 'funnel' => false];
[$status, $headers] = serve_slug($flagged, make_request(['HTTP_IF_NONE_MATCH' => '"ghost99"']));
same('funnel=false: 304 sem conteúdo em disco', 304, $status);
same('funnel=false: ETag só o hash', '"ghost99"', $headers['ETag']);
[$status] = serve_slug($flagged, make_request([]));
same('funnel=false sem ETag do cliente: precisa do conteúdo (503 sem ele)', 503, $status);
// Marca "funnel=true" (ou ausente): lê o conteúdo e aplica a etapa.
cache_put_content($tmpSlug, 'abc123', $server); // o put de def456 apagou as versões antigas
[$status, $headers] = serve_slug($route + ['funnel' => true], make_request(['HTTP_IF_NONE_MATCH' => '"abc123"']));
same('funnel=true: ETag do cliente sem etapa não bate → 200', 200, $status);
same('funnel=true: ETag com etapa', '"abc123-p_pre"', $headers['ETag']);

// ── HTML hostil ao tokenizador: comentário, string JS, wrapper, hidden="hidden" ──
$hostile = '<section class="wrap">'
    . '<section data-dop-page="p_a" data-dop-kind="presell" data-dop-start><h1>A</h1><!-- </section> --><script>var t="<section>";</script><p>A2-SECRET</p></section>'
    . '<section data-dop-page="p_b" data-dop-kind="main" hidden="hidden"><h1>B</h1><template><section>tpl</section></template></section>'
    . '</section>';
$hostileDoc = $doc(' data-dop-funnel="server"', $hostile);
same('wrapper + comentário + script: acha as 2 etapas', ['p_a', 'p_b'], array_column(funnel_sections($hostileDoc), 'id'));
$r = funnel_apply($hostileDoc, ['dop_step' => 'p_b']);
check('etapa B servida sem vazar o fim da A', $r !== null && !str_contains($r['html'], 'A2-SECRET') && str_contains($r['html'], '<h1>B</h1>'), substr((string) ($r['html'] ?? 'null'), 0, 400));
check('hidden="hidden" removido da etapa servida', $r !== null && preg_match('/<section data-dop-page="p_b"[^>]*>/', $r['html'], $m) === 1 && !str_contains($m[0], 'hidden'), $m[0] ?? '');
check('wrapper preservado', $r !== null && str_contains($r['html'], '<section class="wrap">'));
$r = funnel_apply($hostileDoc, []);
check('etapa A servida inteira (comentário e script intactos)', $r !== null && str_contains($r['html'], '<!-- </section> -->') && str_contains($r['html'], 'A2-SECRET') && !str_contains($r['html'], '<h1>B</h1>'));

// Atributo com "$1": não vira backreference ao injetar no body
$weird = $doc(' data-dop-funnel="server"', '<section data-dop-page="p_x" data-dop-start>x</section><section data-dop-page="p_y" data-dop-kind="backredirect" data-dop-trigger="back $1 \\0" hidden>y</section>');
$r = funnel_apply($weird, []);
check('trigger com $1 escapado no body', $r !== null && str_contains($r['html'], 'data-dop-br-trigger="back $1 \\0"'), substr((string) ($r['html'] ?? ''), 0, 300));

check('funnel_is_server_mode: sim', funnel_is_server_mode($server));
check('funnel_is_server_mode: não', !funnel_is_server_mode($browser));
