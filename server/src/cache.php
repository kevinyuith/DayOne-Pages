<?php
/**
 * Disk cache.
 *
 * What is cached, and why in two levels:
 *
 *   routes/<h2>/<sha1(host)>/<sha1(path)>.php
 *       the RESOLVER RESULT for (host, path): the list of candidate routes,
 *       without the HTML. The `conditions` vary per visitor, so the final
 *       response can't be cached — the list can.
 *       Empty list = unknown domain (negative cache, NEGATIVE_TTL).
 *
 *   content/<h2>/<content_hash>.php
 *       the HTML, addressed by its hash (the routes' `content_hash` = sha256
 *       of the HTML). A hash never changes content: edited slug = new hash,
 *       and the same HTML on several domains/paths is a single file. That's
 *       why the file never needs to be invalidated: it only goes in the
 *       cleanup (cache_gc_content), when no route has used it for days.
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

function routes_file(string $host, string $path): string
{
    return routes_dir_for_host($host) . '/' . sha1($path) . '.php';
}

function content_file(string $id): string
{
    $safe = preg_replace('/[^a-f0-9]/', '', strtolower($id)) ?? '';
    return cache_dir() . '/content/' . substr($safe, 0, 2) . '/' . $safe . '.php';
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
        return ['state' => 'NONE', 'entry' => null];
    }
    $entry = json_decode(cache_unwrap($raw) ?? '', true);
    if (!is_array($entry) || !isset($entry['stored_at'], $entry['routes']) || !is_array($entry['routes'])) {
        @unlink($file);
        return ['state' => 'NONE', 'entry' => null];
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

function cache_put_routes(string $host, string $path, array $routes): bool
{
    $entry = ['v' => 1, 'stored_at' => time(), 'host' => $host, 'path' => $path, 'routes' => strip_content($routes)];
    $json = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        return false;
    }
    return atomic_write(routes_file($host, $path), cache_wrap($json));
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

/** Marks the content as in use (the cleanup looks at the file's mtime). */
function cache_touch_content(string $id): void
{
    if ($id !== '') {
        @touch(content_file($id));
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
    $dir = cache_dir() . '/content';
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
    return remove_tree(cache_dir() . '/routes') + remove_tree(cache_dir() . '/content');
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
