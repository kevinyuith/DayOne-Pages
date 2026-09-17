<?php
declare(strict_types=1);

check('cache gravável', cache_writable());

$routes = [
    ['route_id' => 'r1', 'action' => 'SERVE', 'slug_id' => 'aaaa-bbbb', 'content_hash' => 'abc123', 'content' => '<h1>oi</h1>', 'conditions' => []],
];

same('estado inicial NONE', 'NONE', cache_get_routes('example.com', '/')['state']);

check('put content', cache_put_content('aaaa-bbbb', 'abc123', '<h1>oi</h1>'));
same('read content', '<h1>oi</h1>', cache_read_content('aaaa-bbbb', 'abc123'));
check('put routes', cache_put_routes('example.com', '/', $routes));

$got = cache_get_routes('example.com', '/');
same('estado FRESH', 'FRESH', $got['state']);
check('routes sem content', !isset($got['entry']['routes'][0]['content']));
check('has all content', cache_has_all_content($got['entry']['routes']));

// Nova versão da slug apaga a antiga.
check('put content v2', cache_put_content('aaaa-bbbb', 'def456', '<h1>v2</h1>'));
same('content antigo sumiu', null, cache_read_content('aaaa-bbbb', 'abc123'));
check('has all content agora falha (hash antigo na rota)', !cache_has_all_content($got['entry']['routes']));

// Negativo expira antes (NEGATIVE_TTL=1s).
check('put negativo', cache_put_routes('nope.example', '/', []));
same('negativo FRESH', 'FRESH', cache_get_routes('nope.example', '/')['state']);
sleep(2);
same('negativo vira STALE após 1s', 'STALE', cache_get_routes('nope.example', '/')['state']);

// Positivo expira em CACHE_TTL=2s → STALE, e some depois de STALE_MAX_AGE=10s.
sleep(1);
same('positivo STALE após 2s', 'STALE', cache_get_routes('example.com', '/')['state']);

// Purge por host.
check('purge host', purge_host('example.com') >= 1);
same('após purge NONE', 'NONE', cache_get_routes('example.com', '/')['state']);

// Lock.
$l1 = try_lock('k');
check('lock obtido', $l1 !== null);
check('segundo lock falha', try_lock('k') === null);
unlock($l1);
$l2 = try_lock('k');
check('lock liberado', $l2 !== null);
unlock($l2);

// Escrita atômica não deixa temporários.
$leftovers = glob(cache_dir() . '/routes/*/*/.tmp-*') ?: [];
same('sem temporários', 0, count($leftovers));
