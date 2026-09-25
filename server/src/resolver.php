<?php
/**
 * The resolver: decides where the routes for (host, path) come from.
 *
 *   HIT       fresh cache with all content on disk
 *   MISS      went to Supabase and rewrote it
 *   STALE     Supabase failed; served the expired copy
 *   UPDATING  another worker is refreshing; served the expired copy
 *   (null)    nothing on disk and Supabase down → the caller answers 503
 *
 * With SWR=1 and php-fpm, a STALE entry is served right away and refreshed
 * AFTER the response goes out (fastcgi_finish_request): the visitor never
 * waits for Supabase after the first visit.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/**
 * @return array{routes: array, platform: ?array, xcache: string, refresh: bool}|null
 */
function resolve_routes(string $host, string $path): ?array
{
    ['state' => $state, 'entry' => $entry] = cache_get_routes($host, $path);

    if ($state === 'FRESH' && cache_has_all_content($entry['routes'])) {
        return ['routes' => $entry['routes'], 'gate' => $entry['gate'] ?? null, 'xcache' => 'HIT', 'refresh' => false];
    }

    $cfg = config();
    if ($state === 'STALE' && $cfg['swr'] && function_exists('fastcgi_finish_request')) {
        return ['routes' => $entry['routes'], 'gate' => $entry['gate'] ?? null, 'xcache' => 'STALE', 'refresh' => true];
    }

    $lock = try_lock("$host|$path");
    if ($lock !== null) {
        try {
            $fresh = refresh_routes($host, $path);
            if ($fresh !== null) {
                return ['routes' => $fresh, 'gate' => gate_last_refresh_data(), 'xcache' => 'MISS', 'refresh' => false];
            }
            if ($entry !== null) {
                return ['routes' => $entry['routes'], 'gate' => $entry['gate'] ?? null, 'xcache' => 'STALE', 'refresh' => false];
            }
            return null;
        } finally {
            unlock($lock);
        }
    }

    // Another worker is at Supabase.
    if ($entry !== null) {
        return ['routes' => $entry['routes'], 'gate' => $entry['gate'] ?? null, 'xcache' => 'UPDATING', 'refresh' => false];
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

/** One content cache cleanup every so many refreshes (on average). */
const CONTENT_GC_EVERY = 500;

/**
 * Goes to Supabase and rewrites the cache. Returns the routes (without
 * content) or null if Supabase failed. The caller already holds the lock, or
 * accepts the race.
 *
 * resolve brings only each content's hash; the HTML only comes (content_get)
 * for the hashes not yet on disk — in practice, only when a page changes.
 */
function refresh_routes(string $host, string $path): ?array
{
    $r = supabase_resolve($host, $path);
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
        $got = supabase_content_get(array_values($refs));
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
    // In use: the cleanup leaves them alone (the routes' and the gate's).
    foreach (array_merge(route_content_ids($routes), is_array($rulesData) ? gate_content_ids($rulesData) : []) as $id) {
        cache_touch_content($id);
    }

    // Knowing up front that the slug has NO funnel steps (neither server
    // mode nor A/B samples), the 304 goes out without reading the content from disk (see serve_slug).
    $flag = static function (array $c): array {
        $html = !empty($c['slug_id']) && !empty($c['content_hash']) ? cache_read_content((string) $c['content_hash']) : null;
        if ($html !== null) {
            $c['funnel'] = funnel_has_sections($html) || funnel_is_server_mode($html);
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
    }
    return $routes;
}

/** The SWR background refresh: with the lock, no rush. */
function refresh_in_background(string $host, string $path): void
{
    $lock = try_lock("$host|$path");
    if ($lock === null) {
        return;
    }
    try {
        refresh_routes($host, $path);
    } finally {
        unlock($lock);
    }
}
