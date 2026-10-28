<?php
/**
 * Disk cache.
 *
 * What is cached, and why in two levels:
 *
 *   routes/<h2>/<sha1(host)>/<sha1(path)>.r2.php
 *       the RESOLVER RESULT for (host, path): the list of candidate routes,
 *       without the HTML. The `conditions` vary per visitor, so the final
 *       response can't be cached — the list can.
 *       Empty list = unknown domain (negative cache, NEGATIVE_TTL).
 *       The gate's data by reference (`gate_ref`) since 28/10; the `.php`
 *       next to it is the format from before (gate inline), read until the
 *       path is refreshed or the cleanup takes it.
 *
 *   gates/<h2>/<sha256(gate json)>.php
 *       the gate's data, one file per distinct gate, shared by the entries.
 *
 *   content/<h2>/<content_hash>.php
 *       the HTML, addressed by its hash (the routes' `content_hash` = sha256
 *       of the HTML). A hash never changes content: edited slug = new hash,
 *       and the same HTML on several domains/paths is a single file. That's
 *       why the file never needs to be invalidated: it only goes in the
 *       cleanup (cache_gc_content), when no route has used it for days.
 *
 *   content/<h2>/<content_hash>.a<rev>.php
 *       the same HTML as it is served: the pages' files on this server and
 *       the bucket stylesheets inline (assets.php).
 *
 * A routes entry only counts as a HIT if ALL the content it references is on
 * disk; otherwise it becomes a MISS, and the refresh asks Supabase only for
 * the missing HTML (pages.content_get).
 *
 * Atomic writes (tempnam + rename): readers never see a half-written file.
 * flock per (host, path): only one worker goes to Supabase; the others wait
 * or serve the expired copy.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/**
 * Every cache file is a `.php` that starts with this prefix.
 *
 * When the cache folder sits inside the webroot, `routes/<sha1(host)>/...`
 * is guessable (the host is public) and would hand the route rules to anyone
 * who asked. With the prefix, a direct request runs the PHP, gets a 404 and
 * exits; `__halt_compiler()` stops PHP from even parsing what follows, so
 * the stored HTML never runs as code. Reads from disk skip the prefix.
 */
const CACHE_GUARD = "<?php http_response_code(404);exit;__halt_compiler();";

function cache_wrap(string $payload): string
{
    return CACHE_GUARD . $payload;
}

function cache_unwrap(string $raw): ?string
{
    return str_starts_with($raw, CACHE_GUARD) ? substr($raw, strlen(CACHE_GUARD)) : null;
}

function cache_dir(): string
{
    return rtrim(config()['cache_dir'], '/');
}

function cache_writable(): bool
{
    $dir = cache_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0750, true)) {
        return false;
    }
    return is_writable($dir);
}

function routes_dir_for_host(string $host): string
{
    $h = sha1($host);
    return cache_dir() . '/routes/' . substr($h, 0, 2) . '/' . $h;
}

/**
 * The entry as written since 28/10: the gate's data is NOT inside it, only `gate_ref` (see gate_file).
 *
 * Until then every (host, path) carried the gate twice — in the entry and in each route — and the gate is ~79 KB:
 * 676k entries of ~158 KB filled the server's 96 GB disk in a week (28/10). The new entries have their own file name
 * on purpose: a server running the code from before (a deploy of an older tree) doesn't see them, misses, and asks
 * Supabase — it never reads an entry without its gate.
 */
function routes_file(string $host, string $path): string
{
    return routes_dir_for_host($host) . '/' . sha1($path) . '.r2.php';
}

/** The entry in the format from before 28/10 (gate inline): still read, never written; refreshing the path removes it. */
function routes_file_v1(string $host, string $path): string
{
    return routes_dir_for_host($host) . '/' . sha1($path) . '.php';
}

/**
 * The gate's data, addressed by the sha256 of its JSON: one file per distinct gate, shared by every path (and host)
 * that resolves to it. Each write of an entry that uses it touches it, so the cleanup (STALE_MAX_AGE) only takes a
 * gate no entry has been written with for that long — and an entry that old is past STALE_MAX_AGE too.
 */
function gate_file(string $hash): string
{
    $safe = preg_replace('/[^a-f0-9]/', '', strtolower($hash)) ?? '';
    return cache_dir() . '/gates/' . substr($safe, 0, 2) . '/' . $safe . '.php';
}

function content_file(string $id): string
{
    $safe = preg_replace('/[^a-f0-9]/', '', strtolower($id)) ?? '';
    return cache_dir() . '/content/' . substr($safe, 0, 2) . '/' . $safe . '.php';
}

/** A content's delivery version (assets.php): next to it, same cleanup. */
function content_built_file(string $id): string
{
    return substr(content_file($id), 0, -4) . '.a' . ASSETS_REV . '.php';
}

function atomic_write(string $file, string $data): bool
{
    $dir = dirname($file);
    if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
        return false;
    }
    $tmp = @tempnam($dir, '.tmp-');
    if ($tmp === false) {
        return false;
    }
    if (@file_put_contents($tmp, $data) === false) {
        @unlink($tmp);
        return false;
    }
    @chmod($tmp, 0640);
    if (!@rename($tmp, $file)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/**
 * @return array{state: 'FRESH'|'STALE'|'NONE', entry: ?array}
 */
function cache_get_routes(string $host, string $path): array
{
    $file = routes_file($host, $path);
    $raw = @file_get_contents($file);
    if ($raw === false) {
        $file = routes_file_v1($host, $path);
        $raw = @file_get_contents($file);
    }
    if ($raw === false) {
        return ['state' => 'NONE', 'entry' => null];
    }
    $entry = json_decode(cache_unwrap($raw) ?? '', true);
    if (!is_array($entry) || !isset($entry['stored_at'], $entry['routes']) || !is_array($entry['routes'])) {
        @unlink($file);
        return ['state' => 'NONE', 'entry' => null];
    }
    // The gate comes back into the entry, as it always came: readers see `gate`, never `gate_ref`. Without its file
    // the entry is useless (deciding without the gate's data is not the same decision) — a miss, and a refresh.
    if (isset($entry['gate_ref'])) {
        $gate = cache_read_gate((string) $entry['gate_ref']);
        if ($gate === null) {
            @unlink($file);
            return ['state' => 'NONE', 'entry' => null];
        }
        $entry['gate'] = $gate;
        unset($entry['gate_ref']);
    }
    $cfg = config();
    $age = time() - (int) $entry['stored_at'];
    $ttl = $entry['routes'] === [] ? $cfg['negative_ttl'] : $cfg['cache_ttl'];
    if ($age < $ttl) {
        return ['state' => 'FRESH', 'entry' => $entry];
    }
    if ($age < $cfg['stale_max_age']) {
        return ['state' => 'STALE', 'entry' => $entry];
    }
    @unlink($file);
    return ['state' => 'NONE', 'entry' => null];
}

/** Removes each route's `content` before storing: the HTML lives in the content cache. */
function strip_content(array $routes): array
{
    foreach ($routes as &$route) {
        unset($route['content']);
        if (is_array($route['split'] ?? null)) {
            foreach ($route['split'] as &$c) {
                unset($c['content']);
            }
            unset($c);
        }
    }
    return $routes;
}

/**
 * Stores the entry unless the host is over max_paths_per_host — and even then
 * a path it already has is refreshed: only NEW paths are refused. Until 22/10
 * the cap refused every write, so a scanner's thousands of paths left the
 * host's own "/" unrefreshable and every visit waited for Supabase (196 hosts,
 * travenox.com among them since 21/10 17h UTC).
 */
function cache_put_routes_capped(string $host, string $path, array $routes, ?array $gate = null): bool
{
    if (!is_file(routes_file($host, $path)) && host_over_cap($host)) {
        return false;
    }
    return cache_put_routes($host, $path, $routes, $gate);
}

/**
 * Stores the entry with the gate by reference (gate_file). The routes go without their own `gate`: the resolve fuses
 * the same gate into every row (resolver.php) and nobody reads it from a cached route — the gate is the entry's.
 * If the gate's file can't be written, the gate goes inline, as before: never an entry that lost its gate.
 */
function cache_put_routes(string $host, string $path, array $routes, ?array $gate = null): bool
{
    $routes = strip_content($routes);
    foreach ($routes as &$route) {
        unset($route['gate']);
    }
    unset($route);
    $entry = ['v' => 2, 'stored_at' => time(), 'host' => $host, 'path' => $path, 'routes' => $routes];
    $ref = $gate === null ? null : cache_put_gate($gate);
    if ($ref !== null) {
        $entry['gate_ref'] = $ref;
    } else {
        $entry['gate'] = $gate;
    }
    $json = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        return false;
    }
    if (!atomic_write(routes_file($host, $path), cache_wrap($json))) {
        return false;
    }
    @unlink(routes_file_v1($host, $path));
    return true;
}

/** Writes the gate's file if it isn't there yet (and marks it in use if it is). Returns its hash, or null. */
function cache_put_gate(array $gate): ?string
{
    $json = json_encode($gate, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        return null;
    }
    $hash = hash('sha256', $json);
    $file = gate_file($hash);
    if (is_file($file)) {
        @touch($file);
        return $hash;
    }
    return atomic_write($file, cache_wrap($json)) ? $hash : null;
}

/** The gate's data by its hash; null when the file is gone or unreadable. Kept for the request (several paths, one gate). */
function cache_read_gate(string $hash): ?array
{
    static $read = [];
    if (isset($read[$hash])) {
        return $read[$hash];
    }
    $raw = @file_get_contents(gate_file($hash));
    $gate = $raw === false ? null : json_decode(cache_unwrap($raw) ?? '', true);
    if (!is_array($gate)) {
        return null;
    }
    return $read[$hash] = $gate;
}

function cache_put_content(string $id, string $content): bool
{
    $file = content_file($id);
    if (is_file($file)) {
        @touch($file);
        return true;
    }
    return atomic_write($file, cache_wrap($content));
}

function cache_read_content(string $id): ?string
{
    $data = @file_get_contents(content_file($id));
    return $data === false ? null : cache_unwrap($data);
}

function cache_has_content(string $id): bool
{
    return $id !== '' && is_file(content_file($id));
}

/** Marks the content (and its delivery version) as in use (the cleanup looks at the file's mtime). */
function cache_touch_content(string $id): void
{
    if ($id !== '') {
        @touch(content_file($id));
        $built = content_built_file($id);
        if (is_file($built)) {
            @touch($built);
        }
    }
}

/**
 * The content ids the routes serve: the slug's of each SERVE and that of each
 * page in the A/B test between pages (split).
 *
 * @return list<string>
 */
function route_content_ids(array $routes): array
{
    $ids = [];
    foreach ($routes as $route) {
        if (($route['action'] ?? '') !== 'SERVE' || empty($route['slug_id'])) {
            continue;
        }
        $ids[] = (string) ($route['content_hash'] ?? '');
        foreach (is_array($route['split'] ?? null) ? $route['split'] : [] as $c) {
            if (is_array($c) && !empty($c['slug_id'])) {
                $ids[] = (string) ($c['content_hash'] ?? '');
            }
        }
    }
    return array_values(array_unique(array_filter($ids, static fn(string $id): bool => $id !== '')));
}

function cache_has_all_content(array $routes): bool
{
    foreach (route_content_ids($routes) as $id) {
        if (!cache_has_content($id)) {
            return false;
        }
    }
    return true;
}

/**
 * Cleanup: deletes the contents nobody has used for more than $maxAge seconds
 * (each routes refresh marks the ones it uses). Returns how many were removed.
 */
function cache_gc_content(int $maxAge): int
{
    return cache_gc_tree(cache_dir() . '/content', $maxAge);
}

/**
 * Cleanup of the routes entries older than $maxAge (STALE_MAX_AGE): none of
 * them can stand in for Supabase anymore (cache_get_routes drops one when it's
 * read), but a path nobody asks again stayed forever — on 22/10, 1.0 of the
 * 1.4 million entries were over 7 days old and 196 hosts sat past
 * max_paths_per_host. Run at most every ROUTES_GC_EVERY seconds, after a
 * response, by one process (app.php). Returns how many were removed.
 */
const ROUTES_GC_EVERY = 3600;

function cache_gc_routes_maybe(?int $now = null): ?int
{
    $now ??= time();
    $stamp = cache_dir() . '/routes-gc.at';
    clearstatcache(true, $stamp);
    $last = @filemtime($stamp);
    if ($last !== false && $now - $last < ROUTES_GC_EVERY) {
        return null;
    }
    $lock = try_lock('routes-gc');
    if ($lock === null) {
        return null;
    }
    try {
        @touch($stamp, $now);
        $maxAge = config()['stale_max_age'];
        return cache_gc_tree(cache_dir() . '/routes', $maxAge) + cache_gc_tree(cache_dir() . '/gates', $maxAge);
    } finally {
        unlock($lock);
    }
}

/** Deletes the files under $dir not modified for more than $maxAge seconds, and the folders left empty. */
function cache_gc_tree(string $dir, int $maxAge): int
{
    if (!is_dir($dir)) {
        return 0;
    }
    $limit = time() - $maxAge;
    $count = 0;
    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST,
    );
    foreach ($items as $item) {
        if ($item->isDir()) {
            @rmdir($item->getPathname()); // only removed if it ended up empty
        } elseif ($item->getMTime() < $limit && @unlink($item->getPathname())) {
            $count++;
        }
    }
    return $count;
}

/** Deletes the host's routes entries. Returns how many files were removed. */
function purge_host(string $host): int
{
    return remove_tree(routes_dir_for_host($host));
}

function purge_all(): int
{
    return remove_tree(cache_dir() . '/routes') + remove_tree(cache_dir() . '/content') + remove_tree(cache_dir() . '/gates');
}

function remove_tree(string $dir): int
{
    if (!is_dir($dir)) {
        return 0;
    }
    $count = 0;
    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST,
    );
    foreach ($items as $item) {
        if ($item->isDir()) {
            @rmdir($item->getPathname());
        } elseif (@unlink($item->getPathname())) {
            $count++;
        }
    }
    @rmdir($dir);
    return $count;
}

/** Host with too many paths in the cache (crawl, scanner)? Then we stop storing entries for it. */
function host_over_cap(string $host): bool
{
    $dir = routes_dir_for_host($host);
    if (!is_dir($dir)) {
        return false;
    }
    $n = 0;
    $max = config()['max_paths_per_host'];
    foreach (new DirectoryIterator($dir) as $f) {
        if ($f->isFile() && ++$n > $max) {
            return true;
        }
    }
    return false;
}

/** @return resource|null */
function try_lock(string $key)
{
    $dir = cache_dir() . '/locks';
    if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
        return null;
    }
    $h = @fopen($dir . '/' . sha1($key) . '.lock', 'c');
    if ($h === false) {
        return null;
    }
    if (!flock($h, LOCK_EX | LOCK_NB)) {
        fclose($h);
        return null;
    }
    return $h;
}

/** @param resource $h */
function unlock($h): void
{
    flock($h, LOCK_UN);
    fclose($h);
}
