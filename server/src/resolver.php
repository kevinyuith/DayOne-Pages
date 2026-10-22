<?php
/**
 * The resolver: decides where the routes for (host, path) come from.
 *
 *   HIT       fresh cache with all content on disk
 *   MISS      went to Supabase and rewrote it
 *   STALE     Supabase failed or was too slow; served the expired copy
 *   UPDATING  another worker is refreshing; served the expired copy
 *   (null)    nothing on disk and Supabase down → the caller answers 503
 *
 * An expired copy is checked BEFORE the response (09/10). It used to be served
 * right away and refreshed after the response (SWR), so the first visitor after
 * a quiet spell got what was decided at the previous visit — up to STALE_MAX_AGE
 * (7 days) old: a page added to a domain answered 404 once (55 of the 57 new
 * whites of the 30 days before), a domain taken back from Unlocked to Active
 * sent one more visitor to the funnel, a new rule missed one click. A write
 * without a purge only took effect at the second visit, not "within 30 s".
 *
 * The check gets REVALIDATE_TIMEOUT_MS (1 s) when there's a copy to fall back
 * on: Supabase failing or slower than that serves the copy, and it's refreshed
 * after the response (fastcgi_finish_request, the full time limit), as before.
 * The breaker: after a failure, for SUPABASE_BREAKER_SECONDS every expired copy
 * is served right away — an outage doesn't hold each visitor for the time limit.
 * It's the same resolve the background refresh made, so Supabase gets no more
 * calls; only the visitor who arrives after a quiet spell waits for it (~20 ms).
 *
 * The copies in use don't wait for a visitor to expire: a round after a
 * response refreshes them shortly before (prewarm_round, at the end; 22/10).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/**
 * @param (callable(string, string, ?int): ?array)|null $refresh  the refresh (the tests pass a fake Supabase)
 * @param bool|null $background  can refresh after the response (null = SWR on and php-fpm)
 * @return array{routes: array, gate: ?array, xcache: string, refresh: bool}|null
 */
function resolve_routes(string $host, string $path, ?callable $refresh = null, ?bool $background = null): ?array
{
    $refresh ??= 'refresh_routes';
    ['state' => $state, 'entry' => $entry] = cache_get_routes($host, $path);

    if ($state === 'FRESH' && cache_has_all_content($entry['routes'])) {
        return ['routes' => $entry['routes'], 'gate' => $entry['gate'] ?? null, 'xcache' => 'HIT', 'refresh' => false];
    }

    $cfg = config();
    $background ??= $cfg['swr'] && function_exists('fastcgi_finish_request');
    // A copy that can stand in for Supabase: expired, with every page it serves still on disk.
    $fallback = $state === 'STALE' && cache_has_all_content($entry['routes']);
    $copy = static fn(string $xcache, bool $refreshLater): array =>
        ['routes' => $entry['routes'], 'gate' => $entry['gate'] ?? null, 'xcache' => $xcache, 'refresh' => $refreshLater];

    if ($fallback && $background && supabase_breaker_open()) {
        return $copy('STALE', true);
    }

    $lock = try_lock("$host|$path");
    if ($lock !== null) {
        try {
            $t = microtime(true);
            $fresh = $refresh($host, $path, $fallback ? $cfg['revalidate_timeout_ms'] : null);
            server_timing_add('db', (microtime(true) - $t) * 1000);
            if ($fresh !== null) {
                supabase_breaker_close();
                return ['routes' => $fresh, 'gate' => gate_last_refresh_data(), 'xcache' => 'MISS', 'refresh' => false];
            }
            supabase_breaker_trip();
            if ($entry !== null) {
                // Failing or slow: the copy now, the refresh after the response.
                return $copy('STALE', $fallback && $background);
            }
            return null;
        } finally {
            unlock($lock);
        }
    }

    // Another worker is at Supabase.
    if ($entry !== null) {
        return $copy('UPDATING', false);
    }
    for ($i = 0; $i < 20; $i++) {
        usleep(100_000);
        server_timing_add('db', 100.0);
        ['state' => $s, 'entry' => $e] = cache_get_routes($host, $path);
        if ($s === 'FRESH' && cache_has_all_content($e['routes'])) {
            return ['routes' => $e['routes'], 'gate' => $e['gate'] ?? null, 'xcache' => 'HIT', 'refresh' => false];
        }
    }
    return null;
}

/** For how long after a failed refresh every expired copy is served without waiting for Supabase. */
const SUPABASE_BREAKER_SECONDS = 30;

function supabase_breaker_file(): string
{
    return cache_dir() . '/supabase-breaker';
}

/** Did a refresh fail in the last SUPABASE_BREAKER_SECONDS? Shared by the workers: the file's mtime. */
function supabase_breaker_open(): bool
{
    $file = supabase_breaker_file();
    clearstatcache(true, $file);
    $t = @filemtime($file);
    return $t !== false && time() - $t < SUPABASE_BREAKER_SECONDS;
}

function supabase_breaker_trip(): void
{
    @touch(supabase_breaker_file());
}

function supabase_breaker_close(): void
{
    $file = supabase_breaker_file();
    clearstatcache(true, $file);
    if (is_file($file)) {
        @unlink($file);
    }
}

/** One content cache cleanup every so many refreshes (on average). */
const CONTENT_GC_EVERY = 500;

/**
 * Goes to Supabase and rewrites the cache. Returns the routes (without
 * content) or null if Supabase failed. The caller already holds the lock, or
 * accepts the race.
 *
 * resolve brings only each content's hash; the HTML only comes (content_get)
 * for the hashes not yet on disk — in practice, only when a page changes.
 * $timeoutMs: a shorter time limit for each Supabase call (null = SUPABASE_TIMEOUT).
 */
function refresh_routes(string $host, string $path, ?int $timeoutMs = null): ?array
{
    $r = supabase_resolve($host, $path, $timeoutMs);
    if (!$r['ok']) {
        error_log("[dayone-pages] supabase failed for $host$path: " . ($r['error'] ?? '?'));
        return null;
    }
    $routes = $r['routes'];

    // The gate's data comes fused in the resolve's `gate` column (same on every row).
    $rulesData = null;
    foreach ($routes as $row) {
        if (is_array($row['gate'] ?? null)) {
            $rulesData = $row['gate'];
            break;
        }
    }
    if ($rulesData !== null) {
        gate_last_refresh_data($rulesData);
    }

    // HTML that comes along (a resolve that still sends the content) goes straight to disk.
    foreach ($routes as $row) {
        foreach (array_merge([$row], is_array($row['split'] ?? null) ? $row['split'] : []) as $c) {
            if (is_array($c) && isset($c['content']) && !empty($c['content_hash'])) {
                cache_put_content((string) $c['content_hash'], (string) $c['content']);
            }
        }
    }

    // The HTML missing on disk: one (page, slug) request per missing hash —
    // the routes' and the gate's (the funnel pages it may serve).
    $refs = [];
    foreach ($routes as $row) {
        if (($row['action'] ?? '') !== 'SERVE' || empty($row['slug_id'])) {
            continue;
        }
        foreach (array_merge([$row], is_array($row['split'] ?? null) ? $row['split'] : []) as $c) {
            $hash = is_array($c) ? (string) ($c['content_hash'] ?? '') : '';
            if ($hash !== '' && !empty($c['page_id']) && !cache_has_content($hash)) {
                $refs[$c['page_id'] . '|' . $row['slug']] = ['page_id' => (string) $c['page_id'], 'slug' => (string) $row['slug']];
            }
        }
    }
    if (is_array($rulesData)) {
        foreach (gate_content_refs($rulesData) as $ref) {
            if (!cache_has_content(gate_ref_hash($rulesData, $ref['page_id']))) {
                $refs[$ref['page_id'] . '|/'] = $ref;
            }
        }
        // The page versions a vendor page's upsell funnel may serve at a step (upsell.php).
        foreach (upsell_content_refs($rulesData) as $ref) {
            if (!cache_has_content($ref['hash'])) {
                $refs[$ref['page_id'] . '|' . $ref['slug']] = ['page_id' => $ref['page_id'], 'slug' => $ref['slug']];
            }
        }
    }
    if ($refs) {
        $got = supabase_content_get(array_values($refs), $timeoutMs);
        if (!$got['ok']) {
            error_log("[dayone-pages] content_get failed for $host$path: " . ($got['error'] ?? '?'));
            return null;
        }
        // Store by the hash that came back; if the page changed between the resolve and now, the route now points to it.
        $fresh = [];
        foreach ($got['contents'] as $c) {
            cache_put_content($c['content_hash'], $c['content']);
            $fresh[$c['page_id'] . '|' . $c['slug']] = $c['content_hash'];
        }
        foreach ($routes as &$row) {
            if (($row['action'] ?? '') !== 'SERVE' || empty($row['slug_id'])) {
                continue;
            }
            $row['content_hash'] = $fresh[($row['page_id'] ?? '') . '|' . $row['slug']] ?? $row['content_hash'];
            if (is_array($row['split'] ?? null)) {
                foreach ($row['split'] as &$c) {
                    if (is_array($c)) {
                        $c['content_hash'] = $fresh[($c['page_id'] ?? '') . '|' . $row['slug']] ?? $c['content_hash'];
                    }
                }
                unset($c);
            }
        }
        unset($row);
    }
    // In use: the cleanup leaves them alone (the routes' and the gate's). One
    // without its delivery version gets its files after the response (assets.php).
    $upsellIds = is_array($rulesData) ? array_column(upsell_content_refs($rulesData), 'hash') : [];
    foreach (array_merge(route_content_ids($routes), is_array($rulesData) ? gate_content_ids($rulesData) : [], $upsellIds) as $id) {
        cache_touch_content($id);
        if (!is_file(content_built_file($id))) {
            assets_queue($id);
        }
    }

    // Knowing up front that the slug has NO funnel steps (nor A/B samples),
    // the 304 goes out without reading the content from disk (see serve_slug).
    $flag = static function (array $c): array {
        $html = !empty($c['slug_id']) && !empty($c['content_hash']) ? cache_read_content((string) $c['content_hash']) : null;
        if ($html !== null) {
            $c['funnel'] = funnel_has_sections($html);
        }
        return $c;
    };
    foreach ($routes as &$row) {
        $row = $flag($row);
        // A/B test between pages: the same flag for each page in the draw.
        if (is_array($row['split'] ?? null)) {
            $row['split'] = array_map(static fn($c) => is_array($c) ? $flag($c) : $c, $row['split']);
        }
    }
    unset($row);

    $routes = strip_content($routes);
    if (!host_over_cap($host)) {
        cache_put_routes($host, $path, $routes, $rulesData);
    }
    if (random_int(1, CONTENT_GC_EVERY) === 1) {
        // One day beyond the max age of an expired copy: nothing that could still be served is removed.
        cache_gc_content(config()['stale_max_age'] + 86400);
        netinfo_gc();
    }
    return $routes;
}

/** The refresh after the response (an expired copy was served): with the lock, the full time limit. */
function refresh_in_background(string $host, string $path): void
{
    $lock = try_lock("$host|$path");
    if ($lock === null) {
        return;
    }
    try {
        if (refresh_routes($host, $path) !== null) {
            supabase_breaker_close();
        } else {
            supabase_breaker_trip();
        }
    } finally {
        unlock($lock);
    }
}

/*
 * Keeping the copies warm (22/10). An expired copy makes its visitor wait for
 * Supabase before the response (~55 ms; on 22/10 one visit in five arrived on
 * an expired copy — a domain with a click a minute is cold at nearly every
 * click). So the copies in use are refreshed BEFORE they expire, by a round
 * that runs after a response (any domain's), at most every PREWARM_EVERY
 * seconds, one process: the visitor finds a fresh copy, and a change still
 * takes effect within CACHE_TTL (it's the same refresh, only earlier).
 *
 * "In use" = asked at least twice, PREWARM_WINDOW (10 min) or less apart, the
 * last time within PREWARM_WINDOW: a key with a single click in an hour (half
 * of them, 22/10) would cost two resolves a minute to save nothing. Each
 * served or redirected request notes its key (prewarm_note: a small file in
 * cache/used, rewritten at most every PREWARM_NOTE_EVERY seconds, keeping the
 * previous use); the round refreshes the keys whose copy expires within
 * PREWARM_LEAD seconds (or is gone — a purge), oldest first, within
 * PREWARM_BUDGET_MS, each under the key's lock (a visitor refreshing it
 * wins), and stops at the first failure (the breaker trips, as a visitor's
 * refresh would). PREWARM=0 turns it off.
 */
const PREWARM_EVERY = 5;
const PREWARM_LEAD = 10;
const PREWARM_BUDGET_MS = 3000;
const PREWARM_NOTE_EVERY = 10;

function prewarm_dir(): string
{
    return cache_dir() . '/used';
}

function prewarm_file(string $host, string $path): string
{
    return prewarm_dir() . '/' . sha1("$host|$path") . '.json';
}

/** A request used the copy of (host, path): its use is noted, with the previous one. */
function prewarm_note(string $host, string $path, ?int $now = null): void
{
    if (!config()['prewarm']) {
        return;
    }
    $now ??= time();
    $file = prewarm_file($host, $path);
    clearstatcache(true, $file);
    $last = @filemtime($file);
    if ($last !== false && $now - $last < PREWARM_NOTE_EVERY) {
        return;
    }
    $json = json_encode(['host' => $host, 'path' => $path, 'prev' => $last === false ? null : $last], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json !== false && atomic_write($file, $json)) {
        @touch($file, $now);
    }
}

/**
 * A round: refreshes the copies in use that expire within PREWARM_LEAD
 * seconds. Returns how many it refreshed (0 when it isn't this process's turn).
 *
 * @param (callable(string, string, ?int): ?array)|null $refresh  the refresh (the tests pass a fake Supabase)
 */
function prewarm_round(?callable $refresh = null, ?int $now = null): int
{
    $cfg = config();
    if (!$cfg['prewarm']) {
        return 0;
    }
    $now ??= time();
    $stamp = prewarm_dir() . '/.round';
    clearstatcache(true, $stamp);
    $last = @filemtime($stamp);
    if ($last !== false && $now - $last < PREWARM_EVERY) {
        return 0;
    }
    $lock = try_lock('prewarm');
    if ($lock === null) {
        return 0;
    }
    try {
        // Another process may have finished a round between the check and the lock.
        clearstatcache(true, $stamp);
        $last = @filemtime($stamp);
        if ($last !== false && $now - $last < PREWARM_EVERY) {
            return 0;
        }
        if (!is_dir(prewarm_dir()) && !@mkdir(prewarm_dir(), 0750, true) && !is_dir(prewarm_dir())) {
            return 0;
        }
        @touch($stamp, $now);
        if (supabase_breaker_open()) {
            return 0;
        }
        $refresh ??= 'refresh_routes';
        $window = $cfg['prewarm_window'];
        $lead = min(PREWARM_LEAD, intdiv($cfg['cache_ttl'], 3));

        $due = [];
        foreach (glob(prewarm_dir() . '/*.json') ?: [] as $file) {
            $used = @filemtime($file);
            if ($used === false) {
                continue;
            }
            if ($now - $used > $window) {
                @unlink($file); // not in use anymore: two uses again before it's kept warm
                continue;
            }
            $u = json_decode((string) @file_get_contents($file), true);
            if (!is_array($u) || !is_string($u['host'] ?? null) || !is_string($u['path'] ?? null)
                || !is_int($u['prev'] ?? null) || $used - $u['prev'] > $window) {
                continue;
            }
            // The copy's age from its file (written atomically, so mtime = stored_at): no decoding.
            $stored = @filemtime(routes_file($u['host'], $u['path']));
            if ($stored === false && host_over_cap($u['host'])) {
                continue; // a host that isn't cached anymore (cache.php): a refresh wouldn't store it
            }
            $age = $stored === false ? PHP_INT_MAX : $now - $stored;
            if ($age >= $cfg['cache_ttl'] - $lead) {
                $due[] = [$age, $u['host'], $u['path']];
            }
        }
        usort($due, static fn (array $a, array $b): int => $b[0] <=> $a[0]);

        $t0 = microtime(true);
        $done = 0;
        foreach ($due as [, $host, $path]) {
            if ((microtime(true) - $t0) * 1000 >= PREWARM_BUDGET_MS) {
                break; // what's left goes next round, still before it expires
            }
            $keyLock = try_lock("$host|$path");
            if ($keyLock === null) {
                continue; // a visitor's request is refreshing it
            }
            try {
                $ok = $refresh($host, $path, null) !== null;
            } finally {
                unlock($keyLock);
            }
            if (!$ok) {
                supabase_breaker_trip();
                break;
            }
            supabase_breaker_close();
            $done++;
        }
        return $done;
    } finally {
        unlock($lock);
    }
}
