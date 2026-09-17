/**
 * Normalização de host, path e slug — paridade EXATA com o SQL.
 *
 * O banco normaliza por trigger (pages.normalize_host / normalize_path) e o
 * servidor PHP normaliza antes de montar a chave de cache. Este módulo é a
 * terceira cópia, usada pelo dashboard para mostrar o que vai ser gravado e
 * para recusar antes de ir ao banco. Se mudar um, mudam os três.
 */

/** Regex do CHECK de pages.domains.domain. */
export const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Regex do CHECK de pages.page_slugs.slug. */
export const SLUG_RE = /^\/([a-z0-9._~-]+(\/[a-z0-9._~-]+)*)?$/;

/**
 * Host como chega no header: minúsculo, sem porta, sem ponto final, sem `www.`.
 * `www.example.com` e `example.com` são o MESMO domínio.
 */
export function normalizeHost(raw: string): string {
  let host = (raw ?? "").split(":")[0].trim().toLowerCase();
  host = host.replace(/\.$/, "");
  host = host.replace(/^www\./, "");
  return host;
}

export function isValidDomain(host: string): boolean {
  return DOMAIN_RE.test(host) && !host.startsWith("www.") && host.length <= 253;
}

/**
 * Path canônico: sem query/fragment, minúsculo, barra inicial, sem barras
 * duplicadas, sem barra final (exceto a raiz). '' vira '/'.
 */
export function normalizePath(raw: string): string {
  let path = (raw ?? "").split("?")[0].split("#")[0].trim().toLowerCase();
  path = "/" + path;
  path = path.replace(/\/{2,}/g, "/");
  path = path.replace(/(.)\/$/, "$1");
  return path;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && slug.length <= 200;
}
