import { promises as dnsPromises } from "dns";

// Simple cache to avoid repeated lookups of the same IP
const dnsCache = new Map<string, string | null>();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const cacheTimestamps = new Map<string, number>();

export async function reverseDnsLookup(ip: string): Promise<string | null> {
  if (!ip) return null;

  const cached = dnsCache.get(ip);
  if (cached !== undefined) {
    const timestamp = cacheTimestamps.get(ip) ?? 0;
    if (Date.now() - timestamp < CACHE_TTL) {
      return cached;
    }
  }

  try {
    const hostnames = await dnsPromises.reverse(ip);
    const hostname = hostnames?.[0] ?? null;
    dnsCache.set(ip, hostname);
    cacheTimestamps.set(ip, Date.now());
    return hostname;
  } catch {
    dnsCache.set(ip, null);
    cacheTimestamps.set(ip, Date.now());
    return null;
  }
}

/**
 * Enriches hits with hostname info via reverse DNS.
 * Doesn't block if DNS fails — it's fire-and-forget.
 */
export async function enrichWithHostname(
  ip: string,
  updateFn: (hostname: string | null) => Promise<void>
): Promise<void> {
  try {
    const hostname = await reverseDnsLookup(ip);
    await updateFn(hostname);
  } catch {
    // Fails silently — reverse DNS isn't critical
  }
}

/** Clears the cache when needed. */
export function clearDnsCache(): void {
  dnsCache.clear();
  cacheTimestamps.clear();
}

/** Returns the cache size. */
export function getDnsCacheSize(): number {
  return dnsCache.size;
}
