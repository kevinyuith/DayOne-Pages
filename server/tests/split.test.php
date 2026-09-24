<?php
declare(strict_types=1);

// ── Teste A/B entre as páginas de um funil (split_pick + decide) ──

$pA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
$pB = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
$other = '33333333-cccc-4ccc-8ccc-cccccccccccc';
$splitRoute = [
    'action' => 'SERVE', 'match_type' => 'FALLBACK', 'conditions' => [], 'page_id' => $pA, 'slug' => '/',
    'slug_id' => '44444444-0000-4000-8000-00000000000a', 'content_hash' => 'hashA', 'content_type' => 'text/html', 'funnel' => false,
    'split' => [
        ['page_id' => $pA, 'slug_id' => '44444444-0000-4000-8000-00000000000a', 'content_hash' => 'hashA', 'content_type' => 'text/html', 'weight' => 70, 'funnel' => false],
        ['page_id' => $pB, 'slug_id' => '44444444-0000-4000-8000-00000000000b', 'content_hash' => 'hashB', 'content_type' => 'text/html', 'weight' => 30, 'funnel' => false],
    ],
];
$fixed = static fn (int $n) => static fn (int $max): int => min($n, $max - 1);

[$r, $ck] = split_pick(['action' => 'SERVE', 'page_id' => $pA, 'slug_id' => 'x'], []);
check('sem split: rota igual, sem cookie', $r === ['action' => 'SERVE', 'page_id' => $pA, 'slug_id' => 'x'] && $ck === null);

[$r, $ck] = split_pick($splitRoute, [], $fixed(0));
same('sorteio 0 de 100 → A (peso 70)', [$pA, 'hashA', $pA], [$r['page_id'], $r['content_hash'], $ck]);
check('rota escolhida sem a lista do split', !isset($r['split']) && ($r['split_count'] ?? 0) === 2);
[$r, $ck] = split_pick($splitRoute, [], $fixed(85));
same('sorteio 85 de 100 → B (peso 30), slug_id do B', [$pB, '44444444-0000-4000-8000-00000000000b', 'hashB'], [$r['page_id'], $r['slug_id'], $r['content_hash']]);

[$r, $ck] = split_pick($splitRoute, ['dop_pg' => $pB], $fixed(0));
same('cookie manda: quem caiu no B continua no B', $pB, $r['page_id']);
same('cookie igual: não reenvia', null, $ck);
[$r, $ck] = split_pick($splitRoute, ['dop_pg' => "$other,$pB"], $fixed(0));
same('ids de outros funis ficam no cookie, a daqui primeiro', "$pB,$other", $ck);
same('cookie malformado: sorteia de novo', $pA, split_pick($splitRoute, ['dop_pg' => '<x>'], $fixed(0))[0]['page_id']);

$paused = $splitRoute;
$paused['split'][1]['weight'] = 0;
same('peso 0 = pausada: nem quem tinha caído nela continua', $pA, split_pick($paused, ['dop_pg' => $pB], $fixed(99))[0]['page_id']);
$zeros = $splitRoute;
$zeros['split'][0]['weight'] = 0;
$zeros['split'][1]['weight'] = 0;
same('todos 0: partes iguais (sorteio 1 de 2 → B)', $pB, split_pick($zeros, [], $fixed(1))[0]['page_id']);

$a = 0;
for ($i = 0; $i < 10000; $i++) {
    if (split_pick($splitRoute, [])[0]['page_id'] === $pA) {
        $a++;
    }
}
check('10 mil sorteios: ~70% no A', $a > 6700 && $a < 7300, "A=$a");
same('cookie header', "dop_pg=$pA; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax", split_cookie($pA));

// decide: serve a página sorteada (o conteúdo dela), Vary Cookie, Set-Cookie dop_pg, rota devolvida = a escolhida (vai para o log).
cache_put_content('44444444-0000-4000-8000-00000000000a', 'hashA', '<html><body>PAGINA-A</body></html>');
cache_put_content('44444444-0000-4000-8000-00000000000b', 'hashB', '<html><body>PAGINA-B</body></html>');
[$status, $headers, $body, $outcome, $route] = decide([$splitRoute], make_request(['HTTP_COOKIE' => "dop_pg=$pB"]));
same('decide: 200 served', [200, 'served'], [$status, $outcome]);
check('decide: corpo da página B', str_contains((string) $body, 'PAGINA-B') && !str_contains((string) $body, 'PAGINA-A'));
same('decide: rota do log = página B', $pB, $route['page_id']);
check('decide: Vary com Cookie', str_contains($headers['Vary'], 'Cookie'));
check('decide: cookie certo, sem Set-Cookie dop_pg', !str_contains(json_encode($headers['Set-Cookie'] ?? []), 'dop_pg'));
same('decide: ETag da página B', '"hashB-b2"', $headers['ETag']);
[$status, $headers] = decide([$splitRoute], make_request());
check('decide: visitante novo ganha Set-Cookie dop_pg', str_contains(json_encode($headers['Set-Cookie'] ?? []), 'dop_pg='), json_encode($headers['Set-Cookie'] ?? null));

// cache: split sem conteúdo nas rotas guardadas; conferência pede o conteúdo de todas as páginas.
$withContent = $splitRoute;
$withContent['split'][0]['content'] = 'x';
$withContent['split'][1]['content'] = 'y';
$stripped = strip_content([$withContent]);
check('strip_content tira o conteúdo das páginas do split', !isset($stripped[0]['split'][0]['content']) && !isset($stripped[0]['split'][1]['content']));
check('cache_has_all_content: tem as duas páginas', cache_has_all_content([$splitRoute]));
$missing = $splitRoute;
$missing['split'][1]['content_hash'] = 'nao-tem';
check('cache_has_all_content: falta uma página do split → false', !cache_has_all_content([$missing]));

// Aviso de carregamento: clique.
$vid = str_repeat('ab', 16);
$post = static fn () => make_request(['REQUEST_METHOD' => 'POST', 'REQUEST_URI' => '/_dop/l', 'HTTP_COOKIE' => "dop_v=$vid"]);
same('beacon c=1: clique', [$vid, true], [handle_beacon($post(), 'c=1')[3], handle_beacon($post(), 'c=1')[5]]);
same('beacon t=…: carregamento, sem clique', [$vid, false], [handle_beacon($post(), 't=900')[3], handle_beacon($post(), 't=900')[5]]);
check('script manda c=1 no clique que sai da página e ignora "#"', str_contains(BEACON_SCRIPT, 'b("c=1")') && str_contains(BEACON_SCRIPT, 'h.charAt(0)==="#"'));
