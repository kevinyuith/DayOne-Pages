<?php
/**
 * Host and path normalization — EXACT parity with pages.normalize_host and
 * pages.normalize_path in the database (and with src/lib/pages/normalize.ts in
 * the dashboard).
 *
 * If the three copies diverge, the cache stores different keys for the same
 * page and the database matches routes the server doesn't. Changed one,
 * change them all.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** Lowercase, no port, no trailing dot, no `www.`. */
function normalize_host(string $raw): string
{
    $host = strtolower(trim(explode(':', $raw, 2)[0]));
    $host = preg_replace('/\.$/', '', $host) ?? $host;
    $host = preg_replace('/^www\./', '', $host) ?? $host;
    return $host;
}

/** The same CHECK as pages.domains.domain. An invalid host never reaches the database or the cache. */
function is_valid_host(string $host): bool
{
    return $host !== ''
        && strlen($host) <= 253
        && !str_starts_with($host, 'www.')
        && preg_match('/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/', $host) === 1;
}

/**
 * No query/fragment, lowercase, leading slash, no duplicate slashes, no
 * trailing slash (except the root). '' becomes '/'.
 * Doesn't decode %XX: the SQL doesn't either, and the slug CHECK forbids `%`.
 */
function normalize_path(string $raw): string
{
    $path = strtolower(trim(explode('#', explode('?', $raw, 2)[0], 2)[0]));
    $path = '/' . $path;
    $path = preg_replace('#/{2,}#', '/', $path) ?? $path;
    $path = preg_replace('#(.)/$#', '$1', $path) ?? $path;
    return $path;
}
