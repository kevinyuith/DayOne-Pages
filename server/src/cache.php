<?php
/**
 * Cache em disco.
 *
 * O que é cacheado, e por quê em dois níveis:
 *
 *   routes/<h2>/<sha1(host)>/<sha1(path)>.json
 *       o RESULTADO DO RESOLVEDOR para (host, path): a lista de rotas
 *       candidatas, sem o HTML. As `conditions` variam por visitante, então
 *       a resposta final não pode ser cacheada — a lista pode.
 *       Lista vazia = domínio desconhecido (cache negativo, NEGATIVE_TTL).
 *
 *   content/<s2>/<slug_id>-<content_hash>.bin
 *       o HTML de cada slug, endereçado pelo hash. Uma slug editada ganha
 *       hash novo, então o arquivo antigo simplesmente deixa de ser lido.
 *
 * Uma entrada de rotas só vale como HIT se TODO conteúdo que ela referencia
 * está em disco; senão vira MISS e a RPC traz tudo de novo.
 *
 * Escrita atômica (tempnam + rename): quem lê nunca vê arquivo pela metade.
 * flock por (host, path): um worker só vai ao Supabase; os outros esperam ou
 * servem a cópia expirada.
 */
declare(strict_types=1);

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
    return routes_dir_for_host($host) . '/' . sha1($path) . '.json';
}

function content_file(string $slugId, string $hash): string
{
    $safeId = preg_replace('/[^a-f0-9-]/', '', $slugId) ?? '';
    $safeHash = preg_replace('/[^a-f0-9]/', '', $hash) ?? '';
    return cache_dir() . '/content/' . substr($safeId, 0, 2) . '/' . $safeId . '-' . $safeHash . '.bin';
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
    $entry = json_decode($raw, true);
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

/** Remove o `content` de cada rota antes de guardar: o HTML mora no cache de conteúdo. */
function strip_content(array $routes): array
{
    foreach ($routes as &$route) {
        unset($route['content']);
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
    return atomic_write(routes_file($host, $path), $json);
}

function cache_put_content(string $slugId, string $hash, string $content): bool
{
    $file = content_file($slugId, $hash);
    if (is_file($file)) {
        @touch($file);
        return true;
    }
    if (!atomic_write($file, $content)) {
        return false;
    }
    // Versões antigas da mesma slug: fora.
    $prefix = dirname($file) . '/' . basename($file, '-' . preg_replace('/[^a-f0-9]/', '', $hash) . '.bin');
    foreach (glob($prefix . '-*.bin') ?: [] as $sibling) {
        if ($sibling !== $file) {
            @unlink($sibling);
        }
    }
    return true;
}

function cache_read_content(string $slugId, string $hash): ?string
{
    $data = @file_get_contents(content_file($slugId, $hash));
    return $data === false ? null : $data;
}

function cache_has_all_content(array $routes): bool
{
    foreach ($routes as $route) {
        if (($route['action'] ?? '') !== 'SERVE' || empty($route['slug_id'])) {
            continue;
        }
        if (!is_file(content_file((string) $route['slug_id'], (string) ($route['content_hash'] ?? '')))) {
            return false;
        }
    }
    return true;
}

/** Apaga as entradas de rotas do host. Devolve quantos arquivos saíram. */
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

/** Host com paths demais no cache (varredura, scanner)? Aí não guardamos mais entradas dele. */
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
