<?php
declare(strict_types=1);

// ── Teste A/B: uma amostra por etapa, fixa por visitante (cookie dop_ab) ──

$abDoc = static fn (string $body) => "<!doctype html>\n<html><head><title>t</title></head><body>$body<script data-dop-runtime>(function(){})();</script></body></html>";
$ab = $abDoc(
    '<section data-dop-page="p_pa" data-dop-kind="presell" data-dop-weight="70" data-dop-start><h1>PRE-A</h1></section>'
    . '<section data-dop-page="p_pb" data-dop-kind="presell" data-dop-weight="30" hidden><h1>PRE-B</h1></section>'
    . '<section data-dop-page="p_la" data-dop-kind="main" hidden><h1>LAN-A</h1></section>'
    . '<section data-dop-page="p_bra" data-dop-kind="backredirect" data-dop-weight="50" hidden><h1>BR-A</h1></section>'
    . '<section data-dop-page="p_brb" data-dop-kind="backredirect" data-dop-weight="50" hidden> <!-- vazia --> </section>'
);
$fixed = static fn (int $n) => static fn (int $max): int => min($n, $max - 1);
$uid = '0123456789abcdef';

check('sem seções: null', ab_apply('<html><body><h1>x</h1></body></html>', []) === null);

$r = ab_apply($ab, [], $fixed(0));
same('sorteio 0 de 100 → Pre Lander A (peso 70)', 'p_pa', $r['tag']);
check('a outra amostra da etapa sai do HTML', !str_contains($r['html'], 'PRE-B') && str_contains($r['html'], 'PRE-A'));
check('etapa com uma amostra ativa não é teste (Lander e Backredirect ficam)', str_contains($r['html'], 'LAN-A') && str_contains($r['html'], 'BR-A'));
check('amostra vazia (inativa) não entra no sorteio', !str_contains($r['tag'], 'p_brb'));
check('body ganha data-dop-ev', str_contains($r['html'], '<body data-dop-ev>'));
check('cookie novo: visitante + sorteada', preg_match('/^[0-9a-f]{16}:p_pa$/', (string) $r['cookie']) === 1, (string) $r['cookie']);

$r = ab_apply($ab, [], $fixed(85));
same('sorteio 85 de 100 → Pre Lander B (peso 30)', 'p_pb', $r['tag']);
check('B sorteada da etapa inicial fica visível sem JS (sem hidden)', preg_match('/<section data-dop-page="p_pb"[^>]*>/', $r['html'], $m) === 1 && !str_contains($m[0], 'hidden'), $m[0] ?? '');

$r = ab_apply($ab, ['dop_ab' => "$uid:p_pb"], $fixed(0));
same('cookie manda: quem caiu no B continua no B', 'p_pb', $r['tag']);
same('cookie igual: não reenvia', null, $r['cookie']);

$r = ab_apply($ab, ['dop_ab' => "$uid:p_zz,p_pb"], $fixed(0));
same('ids de outras páginas ficam no cookie, as daqui primeiro', "$uid:p_pb,p_zz", $r['cookie']);
same('cookie malformado: visitante novo', 1, preg_match('/^[0-9a-f]{16}:p_pa$/', (string) ab_apply($ab, ['dop_ab' => '<x>'], $fixed(0))['cookie']));

$paused = str_replace('data-dop-weight="30"', 'data-dop-weight="0"', $ab);
same('peso 0 = pausada: nem quem tinha caído nela continua', 'p_pa', ab_apply($paused, ['dop_ab' => "$uid:p_pb"], $fixed(99))['tag']);
$zeros = str_replace(['data-dop-weight="70"', 'data-dop-weight="30"'], 'data-dop-weight="0"', $ab);
same('todos 0: partes iguais (sorteio 1 de 2 → B)', 'p_pb', ab_apply($zeros, [], $fixed(1))['tag']);
$noWeight = str_replace(['data-dop-weight="70"', 'data-dop-weight="30"'], '', $ab);
same('sem peso = 50 cada (sorteio 60 de 100 → B)', 'p_pb', ab_apply($noWeight, [], $fixed(60))['tag']);

// Distribuição: 10 mil sorteios de verdade ficam perto de 70/30.
$a = 0;
for ($i = 0; $i < 10000; $i++) {
    if (ab_apply($ab, [])['tag'] === 'p_pa') {
        $a++;
    }
}
check('10 mil sorteios: ~70% no A', $a > 6700 && $a < 7300, "A=$a");

same('parse: visitante e ids', [$uid, ['p_a', 'p_b']], ab_parse_cookie("$uid:p_a,p_b"));
same('parse: só visitante', [$uid, []], ab_parse_cookie($uid));
same('parse: lixo', [null, []], ab_parse_cookie("$uid:../x"));
same('cookie header', "dop_ab=$uid:p_a; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax", ab_cookie("$uid:p_a"));

// ── serve_slug: amostra no ETag, Vary: Cookie e Set-Cookie ──
$abSlug = '33333333-3333-3333-3333-333333333333';
cache_put_content($abSlug, 'ab01', $ab);
$abRoute = ['slug_id' => $abSlug, 'content_hash' => 'ab01', 'content_type' => 'text/html', 'funnel' => true];
[$status, $headers, $body] = serve_slug($abRoute, make_request(['HTTP_COOKIE' => "dop_ab=$uid:p_pb"]));
same('serve: 200', 200, $status);
same('serve: ETag com a amostra', '"ab01-p_pb-b1"', $headers['ETag']);
check('serve: Vary com Cookie', str_contains($headers['Vary'], 'Cookie'));
check('serve: sem Set-Cookie quando o cookie já está certo', !isset($headers['Set-Cookie']));
check('serve: corpo só com a amostra B', str_contains((string) $body, 'PRE-B') && !str_contains((string) $body, 'PRE-A'));
same('serve: 304 com a mesma amostra', 304, serve_slug($abRoute, make_request(['HTTP_COOKIE' => "dop_ab=$uid:p_pb", 'HTTP_IF_NONE_MATCH' => '"ab01-p_pb-b1"']))[0]);
[$status, $headers] = serve_slug($abRoute, make_request());
check('serve: visitante novo ganha Set-Cookie dop_ab', is_array($headers['Set-Cookie'] ?? null) && str_starts_with($headers['Set-Cookie'][0], 'dop_ab='), json_encode($headers['Set-Cookie'] ?? null));

// Página com etapas mas sem teste: ETag sem amostra, sem Vary Cookie, mas com data-dop-ev e cookie de visitante.
$plainFunnel = $abDoc('<section data-dop-page="p_x" data-dop-kind="presell" data-dop-start><h1>P</h1></section><section data-dop-page="p_y" hidden><h1>L</h1></section>');
cache_put_content($abSlug, 'ab02', $plainFunnel);
[$status, $headers, $body] = serve_slug(['slug_id' => $abSlug, 'content_hash' => 'ab02', 'content_type' => 'text/html', 'funnel' => true], make_request());
same('sem teste: ETag só hash', '"ab02-b1"', $headers['ETag']);
check('sem teste: Vary sem Cookie', !str_contains($headers['Vary'], 'Cookie'));
check('sem teste: body com data-dop-ev (conta visitas/cliques)', str_contains((string) $body, 'data-dop-ev'));
check('sem teste: cookie de visitante', str_starts_with((string) ($headers['Set-Cookie'][0] ?? ''), 'dop_ab='));

// Modo servidor + A/B: primeiro a amostra, depois a etapa.
$both = str_replace('<body>', '<body data-dop-funnel="server">', $ab);
cache_put_content($abSlug, 'ab03', $both);
[$status, $headers, $body] = serve_slug(['slug_id' => $abSlug, 'content_hash' => 'ab03', 'content_type' => 'text/html', 'funnel' => true], make_request(['HTTP_COOKIE' => "dop_ab=$uid:p_pb; dop_step=p_la"]));
same('servidor + A/B: ETag amostra + etapa', '"ab03-p_pb-p_la-b1"', $headers['ETag']);
check('servidor + A/B: só o Lander no corpo', str_contains((string) $body, 'LAN-A') && !str_contains((string) $body, 'PRE-'));
check('servidor + A/B: data-dop-cur e data-dop-ev no body', str_contains((string) $body, 'data-dop-ev') && str_contains((string) $body, 'data-dop-cur="p_la"'));

// resolver: slug com seções não pode usar o atalho do 304 sem ler o conteúdo.
check('funnel_has_sections: sim', funnel_has_sections($plainFunnel));
check('funnel_has_sections: não', !funnel_has_sections('<html><body><section class="x">a</section></body></html>'));

// ── POST /_dop/e ──
$evReq = static fn (string $cookie, array $over = []) => make_request(['REQUEST_METHOD' => 'POST', 'REQUEST_URI' => '/_dop/e', 'HTTP_HOST' => 'www.Loja.com', 'HTTP_COOKIE' => $cookie] + $over);
[$status, $headers, $body, $event] = handle_funnel_event($evReq("dop_ab=$uid:p_pa"), 'e=v&p=p_pa&k=presell&s=%2FOferta');
same('evento: 204 no-store', [204, 'no-store', null], [$status, $headers['Cache-Control'] ?? null, $body]);
same('evento: gravável (host sem www, path normalizado)', ['host' => 'loja.com', 'path' => '/oferta', 'step' => 'p_pa', 'kind' => 'presell', 'event' => 'view', 'visitor' => $uid], $event);
same('evento: clique', 'click', handle_funnel_event($evReq("dop_ab=$uid"), 'e=c&p=p_la&k=main&s=/')[3]['event'] ?? null);
same('evento sem cookie: nada', null, handle_funnel_event($evReq(''), 'e=v&p=p_pa&k=presell&s=/')[3]);
same('evento de robô: nada', null, handle_funnel_event($evReq("dop_ab=$uid", ['HTTP_USER_AGENT' => 'Googlebot/2.1 (+http://www.google.com/bot.html)']), 'e=v&p=p_pa&k=presell&s=/')[3]);
same('evento com tipo inválido: nada', null, handle_funnel_event($evReq("dop_ab=$uid"), 'e=x&p=p_pa&k=presell&s=/')[3]);
same('evento com id inválido: nada', null, handle_funnel_event($evReq("dop_ab=$uid"), 'e=v&p=../x&k=presell&s=/')[3]);
same('evento com etapa inválida: nada', null, handle_funnel_event($evReq("dop_ab=$uid"), 'e=v&p=p_pa&k=upsell&s=/')[3]);
same('evento por GET: 404', 404, handle_funnel_event(make_request(['REQUEST_URI' => '/_dop/e', 'HTTP_COOKIE' => "dop_ab=$uid"]), '')[0]);
