<?php
declare(strict_types=1);

check('cache writable', cache_writable());

$routes = [
    ['route_id' => 'r1', 'action' => 'SERVE', 'slug_id' => 'aaaa-bbbb', 'content_hash' => 'cafe01', 'content' => '<h1>hi</h1>', 'conditions' => []],
];

same('initial state NONE', 'NONE', cache_get_routes('example.com', '/')['state']);

check('put content', cache_put_content('cafe01', '<h1>hi</h1>'));
same('read content', '<h1>hi</h1>', cache_read_content('cafe01'));
check('put of an existing id: does not rewrite', cache_put_content('cafe01', '<h1>other</h1>') && cache_read_content('cafe01') === '<h1>hi</h1>');
check('put routes', cache_put_routes('example.com', '/', $routes));

$got = cache_get_routes('example.com', '/');
same('state FRESH', 'FRESH', $got['state']);
check('routes without content', !isset($got['entry']['routes'][0]['content']));
check('has all content', cache_has_all_content($got['entry']['routes']));

// Content by id: the new version is another file; the old one stays until the cleanup.
check('put content v2', cache_put_content('cafe02', '<h1>v2</h1>'));
same('old content stays', '<h1>hi</h1>', cache_read_content('cafe01'));
check('has all content: the route with the old id still has it', cache_has_all_content($got['entry']['routes']));
check('has all content: id not on disk → false', !cache_has_all_content([['action' => 'SERVE', 'slug_id' => 'x', 'content_hash' => 'fff999']]));
same('route_content_ids: SERVE + split, no repeats or empties', ['cafe01', 'cafe02'], route_content_ids([
    ['action' => 'SERVE', 'slug_id' => 'a', 'content_hash' => 'cafe01', 'split' => [['slug_id' => 'a', 'content_hash' => 'cafe01'], ['slug_id' => 'b', 'content_hash' => 'cafe02']]],
    ['action' => 'SERVE', 'slug_id' => 'c', 'content_hash' => ''],
    ['action' => 'REDIRECT', 'slug_id' => null, 'content_hash' => 'dead00'],
]));
// Cleanup: only what nobody has marked as in use for longer than the limit goes.
touch(content_file('cafe01'), time() - 100);
cache_touch_content('cafe02');
same('cleanup takes only the old one', 1, cache_gc_content(50));
same('cafe01 removed', null, cache_read_content('cafe01'));
same('cafe02 kept', '<h1>v2</h1>', cache_read_content('cafe02'));
check('has all content now fails (id left the disk)', !cache_has_all_content($got['entry']['routes']));

// Negative entries expire sooner (NEGATIVE_TTL=1s).
check('put negative', cache_put_routes('nope.example', '/', []));
same('negative FRESH', 'FRESH', cache_get_routes('nope.example', '/')['state']);
sleep(2);
same('negative becomes STALE after 1s', 'STALE', cache_get_routes('nope.example', '/')['state']);

// Positive expires at CACHE_TTL=2s → STALE, and is gone after STALE_MAX_AGE=10s.
sleep(1);
same('positive STALE after 2s', 'STALE', cache_get_routes('example.com', '/')['state']);

// Purge by host.
check('purge host', purge_host('example.com') >= 1);
same('after purge NONE', 'NONE', cache_get_routes('example.com', '/')['state']);

// Lock.
$l1 = try_lock('k');
check('lock acquired', $l1 !== null);
check('second lock fails', try_lock('k') === null);
unlock($l1);
$l2 = try_lock('k');
check('lock released', $l2 !== null);
unlock($l2);

// Atomic writes leave no temp files.
$leftovers = glob(cache_dir() . '/routes/*/*/.tmp-*') ?: [];
same('no temp files', 0, count($leftovers));
