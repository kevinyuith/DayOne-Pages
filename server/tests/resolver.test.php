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
