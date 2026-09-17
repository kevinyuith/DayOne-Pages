<?php
/**
 * Normalização de host e path — paridade EXATA com pages.normalize_host e
 * pages.normalize_path no banco (e com src/lib/pages/normalize.ts no dashboard).
 *
 * Se as três cópias divergirem, o cache guarda chaves diferentes para a mesma
 * página e o banco casa rotas que o servidor não casa. Mudou uma, mudam todas.
 */
declare(strict_types=1);

/** Minúsculo, sem porta, sem ponto final, sem `www.`. */
function normalize_host(string $raw): string
{
    $host = strtolower(trim(explode(':', $raw, 2)[0]));
    $host = preg_replace('/\.$/', '', $host) ?? $host;
    $host = preg_replace('/^www\./', '', $host) ?? $host;
    return $host;
}

/** O mesmo CHECK de pages.domains.domain. Host inválido nunca chega ao banco nem ao cache. */
function is_valid_host(string $host): bool
{
    return $host !== ''
        && strlen($host) <= 253
        && !str_starts_with($host, 'www.')
        && preg_match('/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/', $host) === 1;
}

/**
 * Sem query/fragment, minúsculo, barra inicial, sem barras duplicadas, sem
 * barra final (exceto a raiz). '' vira '/'.
 * Não decodifica %XX: o SQL também não, e o CHECK da slug proíbe `%`.
 */
function normalize_path(string $raw): string
{
    $path = strtolower(trim(explode('#', explode('?', $raw, 2)[0], 2)[0]));
    $path = '/' . $path;
    $path = preg_replace('#/{2,}#', '/', $path) ?? $path;
    $path = preg_replace('#(.)/$#', '$1', $path) ?? $path;
    return $path;
}
