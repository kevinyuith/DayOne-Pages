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
            $fresh = $refresh($host, $path, $fallback ? $cfg['revalidate_timeout_ms'] : null);
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
    foreach (array_merge(route_content_ids($routes), is_array($rulesData) ? gate_content_ids($rulesData) : []) as $id) {
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
