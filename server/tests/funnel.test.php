<?php
declare(strict_types=1);

$doc = static fn (string $bodyAttrs, string $body) => "<!doctype html>\n<html><head><title>t</title><style>x</style></head><body$bodyAttrs>$body<script data-dop-runtime>(function(){})();</script></body></html>";

$sections = '<section data-dop-page="p_pre" data-dop-name="Presell" data-dop-kind="presell" data-dop-start><main><h1>Presell</h1><section class="inner">nested</section><a href="#next-step">Continue</a></main></section>'
    . '<section data-dop-page="p_vsl" data-dop-name="VSL" data-dop-kind="main" hidden=""><h1>VSL</h1></section>'
    . '<section data-dop-page="p_br" data-dop-name="Stay" data-dop-kind="backredirect" data-dop-trigger="back exit" hidden><h1>Stay</h1></section>';

$browser = $doc('', $sections);
$server = $doc(' data-dop-funnel="server"', $sections);

check('browser mode: untouched', funnel_apply($browser, []) === null);
same('a single step (no kind = Lander): serves it', 'p_a', funnel_apply($doc(' data-dop-funnel="server"', '<section data-dop-page="p_a" data-dop-start>a</section>'), [])['step'] ?? null);
check('no step with code: untouched', funnel_apply($doc(' data-dop-funnel="server"', '<section data-dop-page="p_a" data-dop-kind="presell"> </section><section data-dop-page="p_b"><!-- nothing --></section>'), []) === null);

// ── Fixed steps: no code = inactive; initial = active Pre Lander, otherwise Lander ──
$emptyPre = $doc(' data-dop-funnel="server"', '<section data-dop-page="p_pre" data-dop-kind="presell" data-dop-start> <!-- empty --> &nbsp; </section>'
    . '<section data-dop-page="p_lan" data-dop-kind="main" hidden><h1>Lander</h1></section>'
    . '<section data-dop-page="p_br" data-dop-kind="backredirect" data-dop-trigger="back">' . "\n\t" . '</section>');
$r = funnel_apply($emptyPre, []);
same('pre lander without code: serves the lander', 'p_lan', $r['step'] ?? null);
check('inactive pre lander is not in the HTML', $r !== null && !str_contains($r['html'], 'data-dop-page="p_pre"'));
check('backredirect without code: no data-dop-br', $r !== null && !str_contains($r['html'], 'data-dop-br='));
check('lander is the last one: no next', $r !== null && !str_contains($r['html'], 'data-dop-next='));
same('cookie on an inactive step: falls back to the initial one', 'p_lan', funnel_apply($emptyPre, ['dop_step' => 'p_pre'])['step'] ?? null);
same('cookie on the inactive backredirect: falls back to the initial one', 'p_lan', funnel_apply($emptyPre, ['dop_step' => 'p_br'])['step'] ?? null);

$startOnLander = $doc(' data-dop-funnel="server"', '<section data-dop-page="p_lan" data-dop-kind="main" data-dop-start><h1>L</h1></section>'
    . '<section data-dop-page="p_pre" data-dop-kind="presell" hidden><h1>P</h1></section>');
$r = funnel_apply($startOnLander, []);
same('priority: an active Pre Lander comes first, even with start marked on the Lander', 'p_pre', $r['step'] ?? null);
check('from the Pre Lander, next is the Lander', $r !== null && str_contains($r['html'], 'data-dop-next="p_lan"') && str_contains($r['html'], 'data-dop-start="p_pre"'));
same('unknown kind (old upsell) counts as Lander', 'main', funnel_sections($doc(' data-dop-funnel="server"', '<section data-dop-page="p_u" data-dop-kind="upsell">u</section>'))[0]['kind'] ?? null);
check('funnel_has_code: whitespace, comments and nbsp do not count', !funnel_has_code(" \n<!-- x --> &nbsp;\xC2\xA0 ") && funnel_has_code('<img src="a.png">') && funnel_has_code('text'));

$secs = funnel_sections($server);
same('finds 3 step sections (ignores the nested one)', ['p_pre', 'p_vsl', 'p_br'], array_column($secs, 'id'));
same('kind and trigger read', ['backredirect', 'back exit'], [$secs[2]['kind'], $secs[2]['trigger']]);

$r = funnel_apply($server, []);
same('no cookie: serves the initial one', 'p_pre', $r['step']);
check('no cookie: the VSL is not in the HTML', !str_contains($r['html'], 'VSL'));
check('no cookie: the back redirect is not in the HTML', !str_contains($r['html'], 'Stay'));
check('no cookie: the whole presell is served (with the nested section)', str_contains($r['html'], 'nested') && str_contains($r['html'], 'Continue'));
check('head and runtime preserved', str_contains($r['html'], '<style>x</style>') && str_contains($r['html'], 'data-dop-runtime'));
check('body gets cur/next/main/start/br', preg_match('/<body data-dop-funnel="server" data-dop-cur="p_pre" data-dop-start="p_pre" data-dop-next="p_vsl" data-dop-main="p_vsl" data-dop-br="p_br" data-dop-br-trigger="back exit">/', $r['html']) === 1, substr($r['html'], 0, 300));

$r = funnel_apply($server, ['dop_step' => 'p_vsl']);
same('cookie: serves the VSL', 'p_vsl', $r['step']);
check('cookie: the VSL comes without hidden', preg_match('/<section data-dop-page="p_vsl"[^>]*>/', $r['html'], $m) === 1 && !str_contains($m[0], 'hidden'), $m[0] ?? '');
check('cookie: the presell is not in the HTML', !str_contains($r['html'], 'Presell'));
check('cookie: VSL is the last in the flow → no next', !str_contains($r['html'], 'data-dop-next='));

$r = funnel_apply($server, ['dop_step' => 'p_br']);
same('cookie: serves the back redirect', 'p_br', $r['step']);
check('back redirect: next is the main one', str_contains($r['html'], 'data-dop-next="p_vsl"'));

same('invalid cookie: falls back to the initial one', 'p_pre', funnel_apply($server, ['dop_step' => 'p_nope'])['step']);
same('malformed cookie: falls back to the initial one', 'p_pre', funnel_apply($server, ['dop_step' => '<script>'])['step']);

// serve_slug: ETag per step and Vary by Cookie; 304 only matches the same step.
$tmpSlug = '11111111-1111-1111-1111-111111111111';
cache_put_content('abc123', $server);
$route = ['slug_id' => $tmpSlug, 'content_hash' => 'abc123', 'content_type' => 'text/html; charset=utf-8'];
[$status, $headers, $body] = serve_slug($route, make_request([]));
same('serve_slug 200 on the initial step', 200, $status);
same('ETag with the step (no load notice: not a gate route)', '"abc123-p_pre-k1"', $headers['ETag']);
check('Vary includes Cookie', str_contains($headers['Vary'], 'Cookie'));
check('body with the presell only', str_contains((string) $body, 'Presell') && !str_contains((string) $body, 'VSL'));
[$status] = serve_slug($route, make_request(['HTTP_IF_NONE_MATCH' => '"abc123-p_pre-k1"']));
same('304 on the same step', 304, $status);
[$status, $headers] = serve_slug($route, make_request(['HTTP_IF_NONE_MATCH' => '"abc123-p_pre-k1"', 'HTTP_COOKIE' => 'dop_step=p_vsl']));
same('different step with old ETag → 200', 200, $status);
same('ETag of the new step', '"abc123-p_vsl-k1"', $headers['ETag']);
cache_put_content('def456', $browser);
[$status, $headers] = serve_slug(['slug_id' => $tmpSlug, 'content_hash' => 'def456', 'content_type' => ''], make_request([]));
same('browser mode: ETag is just the hash (no load notice)', '"def456-k1"', $headers['ETag']);
check('browser mode: Vary without Cookie', !str_contains($headers['Vary'], 'Cookie'));
// "funnel=false" flag in the routes cache: 304 without reading the content (the file may even be gone).
$flagged = ['slug_id' => $tmpSlug, 'content_hash' => 'ghost99', 'content_type' => '', 'funnel' => false];
[$status, $headers] = serve_slug($flagged, make_request(['HTTP_IF_NONE_MATCH' => '"ghost99"']));
same('funnel=false: 304 with no content on disk', 304, $status);
same('funnel=false: ETag is just the hash (no load notice)', '"ghost99"', $headers['ETag']);
[$status] = serve_slug($flagged, make_request([]));
same('funnel=false without a client ETag: needs the content (503 without it)', 503, $status);
// "funnel=true" flag (or missing): reads the content and applies the step.
[$status, $headers] = serve_slug($route + ['funnel' => true], make_request(['HTTP_IF_NONE_MATCH' => '"abc123"']));
same('funnel=true: client ETag without a step does not match → 200', 200, $status);
same('funnel=true: ETag with the step', '"abc123-p_pre-k1"', $headers['ETag']);

// ── HTML hostile to the tokenizer: comment, JS string, wrapper, hidden="hidden" ──
$hostile = '<section class="wrap">'
    . '<section data-dop-page="p_a" data-dop-kind="presell" data-dop-start><h1>A</h1><!-- </section> --><script>var t="<section>";</script><p>A2-SECRET</p></section>'
    . '<section data-dop-page="p_b" data-dop-kind="main" hidden="hidden"><h1>B</h1><template><section>tpl</section></template></section>'
    . '</section>';
$hostileDoc = $doc(' data-dop-funnel="server"', $hostile);
same('wrapper + comment + script: finds the 2 steps', ['p_a', 'p_b'], array_column(funnel_sections($hostileDoc), 'id'));
$r = funnel_apply($hostileDoc, ['dop_step' => 'p_b']);
check('step B served without leaking the end of A', $r !== null && !str_contains($r['html'], 'A2-SECRET') && str_contains($r['html'], '<h1>B</h1>'), substr((string) ($r['html'] ?? 'null'), 0, 400));
check('hidden="hidden" removed from the served step', $r !== null && preg_match('/<section data-dop-page="p_b"[^>]*>/', $r['html'], $m) === 1 && !str_contains($m[0], 'hidden'), $m[0] ?? '');
check('wrapper preserved', $r !== null && str_contains($r['html'], '<section class="wrap">'));
$r = funnel_apply($hostileDoc, []);
check('step A served whole (comment and script intact)', $r !== null && str_contains($r['html'], '<!-- </section> -->') && str_contains($r['html'], 'A2-SECRET') && !str_contains($r['html'], '<h1>B</h1>'));

// Attribute with "$1": does not turn into a backreference when injected into body
$weird = $doc(' data-dop-funnel="server"', '<section data-dop-page="p_x" data-dop-start>x</section><section data-dop-page="p_y" data-dop-kind="backredirect" data-dop-trigger="back $1 \\0" hidden>y</section>');
$r = funnel_apply($weird, []);
check('trigger with $1 escaped on body', $r !== null && str_contains($r['html'], 'data-dop-br-trigger="back $1 \\0"'), substr((string) ($r['html'] ?? ''), 0, 300));

check('funnel_is_server_mode: yes', funnel_is_server_mode($server));
check('funnel_is_server_mode: no', !funnel_is_server_mode($browser));

// ── Cookie header → Request->cookies (server mode reads dop_step from here) ──
$withCookie = make_request(['HTTP_COOKIE' => 'dop_step=p_ab12; _ga=GA1.2; seen=1']);
same('cookie header parsed', ['dop_step' => 'p_ab12', '_ga' => 'GA1.2', 'seen' => '1'], $withCookie->cookies);
same('cookie header missing', [], make_request([])->cookies);
same('cookie decodes the value', ['k' => 'a b'], parse_cookie_header('k=a%20b'));
same('repeated cookie: the first one wins', ['k' => '1'], parse_cookie_header('k=1; k=2'));
