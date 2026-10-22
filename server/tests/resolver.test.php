<?php
declare(strict_types=1);

// ── resolver.php: an expired copy is checked before the response (09/10) ──

/** An entry stored $age seconds ago (run.php: CACHE_TTL=2, NEGATIVE_TTL=1, STALE_MAX_AGE=10). */
function resolver_put_aged(string $host, array $routes, int $age): void
{
    $entry = ['v' => 1, 'stored_at' => time() - $age, 'host' => $host, 'path' => '/', 'routes' => $routes, 'gate' => null];
    atomic_write(routes_file($host, '/'), cache_wrap((string) json_encode($entry)));
}

/** A fake Supabase: answers $answer and records the time limit of each call. */
function resolver_fake(?array $answer, array &$calls): callable
{
    return static function (string $host, string $path, ?int $timeoutMs) use ($answer, &$calls): ?array {
        $calls[] = $timeoutMs;
        return $answer;
    };
}

$page = [['route_id' => 'r1', 'action' => 'SERVE', 'slug_id' => 's1', 'slug' => '/', 'content_hash' => 'resolver01', 'conditions' => []]];
$newer = [['route_id' => 'r2', 'action' => 'SERVE', 'slug_id' => 's2', 'slug' => '/', 'content_hash' => 'resolver01', 'conditions' => []]];
cache_put_content('resolver01', '<h1>white</h1>');
supabase_breaker_close();

// A fresh copy: served, Supabase not asked.
$calls = [];
resolver_put_aged('fresh.example', $page, 0);
$r = resolve_routes('fresh.example', '/', resolver_fake($newer, $calls), true);
same('fresh copy: HIT', 'HIT', $r['xcache']);
same('fresh copy: Supabase not asked', [], $calls);

// An expired copy with Supabase answering: the visitor gets the new decision (it used to get the copy).
$calls = [];
resolver_put_aged('expired.example', $page, 5);
$r = resolve_routes('expired.example', '/', resolver_fake($newer, $calls), true);
same('expired copy, Supabase ok: MISS (checked before the response)', 'MISS', $r['xcache']);
same('expired copy, Supabase ok: the new routes', 'r2', $r['routes'][0]['route_id'] ?? null);
same('expired copy: the short time limit', [config()['revalidate_timeout_ms']], $calls);
same('expired copy: nothing left for after the response', false, $r['refresh']);

// 08/10: a page added to a domain whose cached decision was "no page" answered 404 once.
$calls = [];
resolver_put_aged('newwhite.example', [], 5);
$r = resolve_routes('newwhite.example', '/', resolver_fake($page, $calls), true);
same('expired "no page", the page now in Supabase: MISS (no 404)', 'MISS', $r['xcache']);
same('expired "no page": served with the page', 'r1', $r['routes'][0]['route_id'] ?? null);

// Supabase failing or slower than the limit: the copy, refreshed after the response; the breaker trips.
$calls = [];
resolver_put_aged('down.example', $page, 5);
$r = resolve_routes('down.example', '/', resolver_fake(null, $calls), true);
same('Supabase failing: STALE (the copy)', 'STALE', $r['xcache']);
same('Supabase failing: the routes of the copy', 'r1', $r['routes'][0]['route_id'] ?? null);
same('Supabase failing: refreshed after the response', true, $r['refresh']);
check('Supabase failing: the breaker trips', supabase_breaker_open());

// The breaker open: the next expired copy is served without waiting for Supabase.
$calls = [];
resolver_put_aged('down2.example', $page, 5);
$r = resolve_routes('down2.example', '/', resolver_fake($newer, $calls), true);
same('breaker open: STALE right away', 'STALE', $r['xcache']);
same('breaker open: Supabase not asked before the response', [], $calls);
same('breaker open: refreshed after the response', true, $r['refresh']);

// Without php-fpm there's no "after the response": it asks even with the breaker open.
$calls = [];
$r = resolve_routes('down2.example', '/', resolver_fake($newer, $calls), false);
same('no refresh after the response: asks', 'MISS', $r['xcache']);
check('a success closes the breaker', !supabase_breaker_open());

// No copy at all: the full time limit (null), and null when Supabase fails (the caller answers 503).
$calls = [];
same('no copy, Supabase failing: null', null, resolve_routes('none.example', '/', resolver_fake(null, $calls), true));
same('no copy: the full time limit', [null], $calls);
supabase_breaker_close();

// An expired copy whose page left the disk can't stand in for Supabase: the full time limit.
$calls = [];
resolver_put_aged('nocontent.example', [['route_id' => 'r3', 'action' => 'SERVE', 'slug_id' => 's3', 'slug' => '/', 'content_hash' => 'gone99', 'conditions' => []]], 5);
resolve_routes('nocontent.example', '/', resolver_fake($newer, $calls), true);
same('expired copy without its page on disk: the full time limit', [null], $calls);

// Another worker refreshing the same path: the copy (UPDATING), without asking.
$calls = [];
resolver_put_aged('busy.example', $page, 5);
$held = try_lock('busy.example|/');
$r = resolve_routes('busy.example', '/', resolver_fake($newer, $calls), true);
unlock($held);
same('another worker refreshing: UPDATING', 'UPDATING', $r['xcache']);
same('another worker refreshing: Supabase not asked', [], $calls);
supabase_breaker_close();

// ── Server-Timing (http.php): app = this request in PHP, db = its wait for Supabase ──
$GLOBALS['dop_server_timing'] = [];
same('Server-Timing: app only when nothing waited', 'app;dur=12.3', server_timing_value(100.0, 100.0123));
server_timing_add('db', 30.04);
server_timing_add('db', 18.02);
same('Server-Timing: the db waits add up', 'app;dur=12.3, db;dur=48.1', server_timing_value(100.0, 100.0123));

$GLOBALS['dop_server_timing'] = [];
$calls = [];
resolver_put_aged('fresh.example', $page, 0);
resolve_routes('fresh.example', '/', resolver_fake($newer, $calls), true);
check('Server-Timing: a fresh copy waits for nothing', !isset($GLOBALS['dop_server_timing']['db']));
resolver_put_aged('expired2.example', $page, 5);
resolve_routes('expired2.example', '/', resolver_fake($newer, $calls), true);
check('Server-Timing: an expired copy records its wait for Supabase', isset($GLOBALS['dop_server_timing']['db']));
$GLOBALS['dop_server_timing'] = [];

// ── Keeping the copies warm (22/10): refreshed before they expire, only the ones in use ──
/** A fake Supabase that records which keys it was asked for. */
function prewarm_fake(?array $answer, array &$asked): callable
{
    return static function (string $host, string $path, ?int $timeoutMs) use ($answer, &$asked): ?array {
        $asked[] = "$host$path" . ($timeoutMs === null ? '' : " ($timeoutMs ms)");
        return $answer;
    };
}

/** An entry for (host, /) stored $age seconds before $now: the round reads the age from the file. */
function prewarm_put_aged(string $host, array $routes, int $now, int $age): void
{
    resolver_put_aged($host, $routes, $age);
    touch(routes_file($host, '/'), $now - $age);
}

$T = time();
@unlink(prewarm_dir() . '/.round');

// The use note: written at most every PREWARM_NOTE_EVERY seconds, with the previous use.
prewarm_note('note.example', '/', $T - 30);
$u = json_decode((string) file_get_contents(prewarm_file('note.example', '/')), true);
same('use note: host and path', ['note.example', '/'], [$u['host'] ?? null, $u['path'] ?? null]);
same('use note: first use has no previous one', [true, null], [array_key_exists('prev', $u), $u['prev'] ?? null]);
prewarm_note('note.example', '/', $T - 25);
$u = json_decode((string) file_get_contents(prewarm_file('note.example', '/')), true);
same('use note: within PREWARM_NOTE_EVERY, not rewritten', [true, null], [array_key_exists('prev', $u), $u['prev'] ?? null]);
prewarm_note('note.example', '/', $T - 20);
$u = json_decode((string) file_get_contents(prewarm_file('note.example', '/')), true);
same('use note: later, the previous use kept', $T - 30, $u['prev'] ?? null);
@unlink(prewarm_file('note.example', '/'));

// Used twice, the copy about to expire (tests: CACHE_TTL 2) → refreshed, with the full time limit.
prewarm_note('warm.example', '/', $T - 60);
prewarm_note('warm.example', '/', $T - 30);
prewarm_put_aged('warm.example', $page, $T, 5);
// Used once in the window → left alone (a single click would cost two resolves a minute).
prewarm_note('once.example', '/', $T - 30);
prewarm_put_aged('once.example', $page, $T, 5);
// Used twice but the copy is fresh → not yet.
prewarm_note('freshw.example', '/', $T - 60);
prewarm_note('freshw.example', '/', $T - 30);
prewarm_put_aged('freshw.example', $page, $T, 0);
// Used twice, the copy gone (a purge) → refreshed first.
prewarm_note('purged.example', '/', $T - 60);
prewarm_note('purged.example', '/', $T - 30);
@unlink(routes_file('purged.example', '/'));
// Last used before the window → forgotten.
prewarm_note('old.example', '/', $T - 2000);
prewarm_note('old.example', '/', $T - 1900);
prewarm_put_aged('old.example', $page, $T, 5);

$asked = [];
same('prewarm round: two copies refreshed', 2, prewarm_round(prewarm_fake($newer, $asked), $T));
same('prewarm round: the gone copy first, then the oldest, full time limit', ['purged.example/', 'warm.example/'], $asked);
check('prewarm round: a key out of use is forgotten', !is_file(prewarm_file('old.example', '/')));
check('prewarm round: a key used once is kept noted', is_file(prewarm_file('once.example', '/')));

$asked = [];
same('prewarm round: at most every PREWARM_EVERY seconds', 0, prewarm_round(prewarm_fake($newer, $asked), $T + 1));
same('prewarm round: nothing asked off-turn', [], $asked);

// A visitor refreshing the key holds its lock → the round leaves it to the visitor.
@unlink(prewarm_dir() . '/.round');
$asked = [];
$held = try_lock('warm.example|/');
prewarm_round(prewarm_fake($newer, $asked), $T);
unlock($held);
same('prewarm round: a key a visitor is refreshing is skipped', ['purged.example/'], $asked);

// Supabase failing → stops at the first failure and trips the breaker; with it open, no round.
@unlink(prewarm_dir() . '/.round');
$asked = [];
same('prewarm round: Supabase failing refreshes nothing', 0, prewarm_round(prewarm_fake(null, $asked), $T));
same('prewarm round: stops at the first failure', ['purged.example/'], $asked);
check('prewarm round: a failure trips the breaker', supabase_breaker_open());
@unlink(prewarm_dir() . '/.round');
$asked = [];
same('prewarm round: breaker open, no round', 0, prewarm_round(prewarm_fake($newer, $asked), $T));
same('prewarm round: breaker open, Supabase not asked', [], $asked);
supabase_breaker_close();
foreach (glob(prewarm_dir() . '/*.json') ?: [] as $f) {
    @unlink($f);
}
@unlink(prewarm_dir() . '/.round');
