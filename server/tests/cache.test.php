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

// ── The path cap (22/10): a host over max_paths_per_host still refreshes the paths it has ──
$capHost = 'capped.example';
$capDir = routes_dir_for_host($capHost);
@mkdir($capDir, 0750, true);
cache_put_routes($capHost, '/', [['route_id' => 'old', 'action' => 'SERVE']]);
for ($i = 0; $i < config()['max_paths_per_host']; $i++) {
    touch($capDir . '/junk' . $i . '.php');
}
check('path cap: the host is over it', host_over_cap($capHost));
same('path cap: a NEW path is not stored', false, cache_put_routes_capped($capHost, '/.env', [['route_id' => 'x']]));
check('path cap: the new path left no file', !is_file(routes_file($capHost, '/.env')));
same('path cap: a path it has is refreshed', true, cache_put_routes_capped($capHost, '/', [['route_id' => 'new', 'action' => 'SERVE']]));
same('path cap: the refreshed entry is the new one', 'new', cache_get_routes($capHost, '/')['entry']['routes'][0]['route_id'] ?? null);
atomic_write(routes_file_v1($capHost, '/old'), cache_wrap((string) json_encode(['v' => 1, 'stored_at' => time(), 'host' => $capHost, 'path' => '/old', 'routes' => [['route_id' => 'v1']], 'gate' => null])));
same('path cap: a path it has in the format from before 28/10 is refreshed too', true, cache_put_routes_capped($capHost, '/old', [['route_id' => 'v2', 'action' => 'SERVE']]));
check('path cap: … into the new format', is_file(routes_file($capHost, '/old')) && !is_file(routes_file_v1($capHost, '/old')));
remove_tree($capDir);

// ── The routes cleanup: entries older than STALE_MAX_AGE go, at most once an hour ──
cache_put_routes('gc-old.example', '/', [['route_id' => 'a']]);
touch(routes_file('gc-old.example', '/'), time() - config()['stale_max_age'] - 5);
cache_put_routes('gc-new.example', '/', [['route_id' => 'b']]);
@unlink(cache_dir() . '/routes-gc.at');
$removed = cache_gc_routes_maybe();
check('routes cleanup: removed the old entry', is_int($removed) && $removed >= 1 && !is_file(routes_file('gc-old.example', '/')));
check('routes cleanup: kept the recent one', is_file(routes_file('gc-new.example', '/')));
check('routes cleanup: the old host folder is gone', !is_dir(routes_dir_for_host('gc-old.example')));
same('routes cleanup: at most once an hour', null, cache_gc_routes_maybe(time() + 60));
@unlink(cache_dir() . '/routes-gc.at');

// ── The gate by reference (28/10): one file per distinct gate, the entry carries only `gate_ref` ──
// Until 28/10 each (host, path) carried the ~79 KB gate twice (entry + every route): 676k entries filled 96 GB.
$gate = ['rules' => [['id' => 'g1', 'conditions' => [['type' => 'country', 'values' => ['US', 'CA']]]]], 'funnels' => ['F1' => ['split' => [['page_id' => 'p1', 'weight' => 0.5]]]], 'blob' => str_repeat('x', 5000), 'n' => 1.25, 'empty' => [], 'none' => null];
$gRoutes = [
    ['route_id' => 'g-r1', 'action' => 'SERVE', 'slug_id' => 's1', 'content_hash' => 'c1', 'content' => '<p>x</p>', 'gate' => $gate],
    ['route_id' => 'g-r2', 'action' => 'REDIRECT', 'gate' => $gate],
];
check('gate: put routes with the gate', cache_put_routes('gate.example', '/a', $gRoutes, $gate));
$gotA = cache_get_routes('gate.example', '/a');
same('gate: comes back FRESH', 'FRESH', $gotA['state']);
same('gate: the entry gets the gate back exactly as stored', $gate, $gotA['entry']['gate'] ?? null);
check('gate: readers never see gate_ref', !array_key_exists('gate_ref', $gotA['entry']));
check('gate: cached routes carry no gate of their own', !array_key_exists('gate', $gotA['entry']['routes'][0]) && !array_key_exists('gate', $gotA['entry']['routes'][1]));
check('gate: cached routes keep the rest (minus content)', ($gotA['entry']['routes'][0]['route_id'] ?? null) === 'g-r1' && !isset($gotA['entry']['routes'][0]['content']));
$entrySize = filesize(routes_file('gate.example', '/a'));
check('gate: the entry file no longer holds the gate', $entrySize < 1000, "size $entrySize");
check('gate: second path, same gate', cache_put_routes('gate.example', '/b', $gRoutes, $gate));
check('gate: other host, same gate', cache_put_routes('gate2.example', '/', $gRoutes, $gate));
$gateFiles = glob(cache_dir() . '/gates/*/*.php') ?: [];
same('gate: one file for the three entries', 1, count($gateFiles));
same('gate: the other host reads the same gate', $gate, cache_get_routes('gate2.example', '/')['entry']['gate'] ?? null);

// No gate: stored as before (null inline), no gate file.
check('gate: put without a gate', cache_put_routes('nogate.example', '/', [['route_id' => 'n1']]));
$noGate = cache_get_routes('nogate.example', '/')['entry'];
check('gate: entry without a gate reads gate null', array_key_exists('gate', $noGate) && $noGate['gate'] === null);
same('gate: no gate file for it', 1, count(glob(cache_dir() . '/gates/*/*.php') ?: []));

// The format from before (gate inline, `.php`): still read, removed when the path is refreshed.
$v1 = ['v' => 1, 'stored_at' => time(), 'host' => 'old.example', 'path' => '/', 'routes' => [['route_id' => 'v1', 'gate' => $gate]], 'gate' => $gate];
atomic_write(routes_file_v1('old.example', '/'), cache_wrap((string) json_encode($v1, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)));
$gotV1 = cache_get_routes('old.example', '/');
same('gate: an entry in the old format is still a HIT', 'FRESH', $gotV1['state']);
same('gate: … with its inline gate', $gate, $gotV1['entry']['gate'] ?? null);
check('gate: refresh old path', cache_put_routes('old.example', '/', [['route_id' => 'v2']], $gate));
check('gate: the refresh removed the old file', !is_file(routes_file_v1('old.example', '/')) && is_file(routes_file('old.example', '/')));
same('gate: and reads the new one', 'v2', cache_get_routes('old.example', '/')['entry']['routes'][0]['route_id'] ?? null);

// The gate file gone: the entry is useless — a miss (the refresh asks Supabase again). A gate this request never
// read (one it already read is kept for the request: same hash, same data).
$gate2 = $gate + ['other' => 'version'];
check('gate: put with a gate not read yet', cache_put_routes('gate.example', '/e', $gRoutes, $gate2));
foreach (glob(cache_dir() . '/gates/*/*.php') ?: [] as $f) {
    @unlink($f);
}
same('gate: without its gate file the entry is NONE', 'NONE', cache_get_routes('gate.example', '/e')['state']);
check('gate: … and the orphan entry was removed', !is_file(routes_file('gate.example', '/e')));

// Cleanup and purge take the gates too.
check('gate: put again', cache_put_routes('gate.example', '/c', $gRoutes, $gate));
foreach (glob(cache_dir() . '/gates/*/*.php') ?: [] as $f) {
    touch($f, time() - config()['stale_max_age'] - 5);
}
@unlink(cache_dir() . '/routes-gc.at');
cache_gc_routes_maybe();
same('gate: the routes cleanup takes a gate unused for STALE_MAX_AGE', 0, count(glob(cache_dir() . '/gates/*/*.php') ?: []));
@unlink(cache_dir() . '/routes-gc.at');
check('gate: put for purge', cache_put_routes('gate.example', '/d', $gRoutes, $gate));
purge_all();
same('gate: purge_all removes the gates', 0, count(glob(cache_dir() . '/gates/*/*.php') ?: []));
