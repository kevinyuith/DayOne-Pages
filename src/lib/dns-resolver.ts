import dns from "dns";
import { promises as dnsPromises } from "dns";

// Cache simples para evitar múltiplas lookups do mesmo IP
const dnsCache = new Map<string, string | null>();
const CACHE_TTL = 1000 * 60 * 60; // 1 hora
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
 * Função para enriquecer hits com informação de hostname via reverse DNS.
 * Não trava se o DNS falhar — é fire-and-forget.
 */
export async function enrichWithHostname(
  ip: string,
  updateFn: (hostname: string | null) => Promise<void>
): Promise<void> {
  try {
    const hostname = await reverseDnsLookup(ip);
    await updateFn(hostname);
  } catch {
    // Silenciosamente falha — reverse DNS não é crítico
  }
}

/** Para limpeza de cache se necessário. */
export function clearDnsCache(): void {
  dnsCache.clear();
  cacheTimestamps.clear();
}

/** Retorna tamanho do cache. */
export function getDnsCacheSize(): number {
  return dnsCache.size;
}
