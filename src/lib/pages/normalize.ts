/**
 * Host, path and slug normalization — EXACT parity with the SQL.
 *
 * The database normalizes via trigger (pages.normalize_host / normalize_path) and
 * the PHP server normalizes before building the cache key. This module is the
 * third copy, used by the dashboard to show what will be saved and to reject
 * input before it reaches the database. Change one, change all three.
 */

/** Regex of the CHECK on pages.domains.domain. */
export const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Regex of the CHECK on pages.page_slugs.slug. */
export const SLUG_RE = /^\/([a-z0-9._~-]+(\/[a-z0-9._~-]+)*)?$/;

/**
 * Host as it arrives in the header: lowercase, no port, no trailing dot, no `www.`.
 * `www.example.com` and `example.com` are the SAME domain.
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
 * Canonical path: no query/fragment, lowercase, leading slash, no duplicate
 * slashes, no trailing slash (except the root). '' becomes '/'.
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
