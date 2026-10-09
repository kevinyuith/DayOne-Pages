/**
 * Instant purge: tells the delivery server to forget a host's routes.
 *
 * The server checks an expired copy of a host's routes before answering
 * (CACHE_TTL, 30 s), so a write takes effect within 30 s on its own; a purge
 * makes it immediate.
 *
 * Nothing to configure here (09/10): the database signs the request —
 * pages.purge_request, an HMAC of "host|time" with the purge token kept in
 * Vault (= PURGE_TOKEN in the server's config.php) — and it goes to the host
 * itself, https://<host>/_purge: the server answers /_purge on every domain it
 * serves. The token never leaves the database, and only a verified domain gets
 * a signature (any other is skipped). Until 09/10 this needed ORIGIN_URL and
 * PURGE_TOKEN here, and production never had them. dayone-main purges the same
 * way (src/lib/dayone-pages/purge-servidor.ts).
 */

import { supabaseService } from "@/lib/supabase/service";

export type PurgeResult = { ok: true; purged: number } | { ok: false; skipped: true } | { ok: false; skipped: false; error: string };

const TIMEOUT_MS = 5_000;

type SignedPurge = { url: string; host: string; time: string; signature: string };

export async function purgeHost(host: string): Promise<PurgeResult> {
  let signed: SignedPurge | null;
  try {
    const { data, error } = await supabaseService().rpc("purge_request", { p_host: host });
    if (error) return { ok: false, skipped: false, error: `purge_request: ${error.message}` };
    signed = (data as SignedPurge | null) ?? null;
  } catch (cause) {
    return { ok: false, skipped: false, error: cause instanceof Error ? cause.message : "purge_request failed" };
  }
  // Not a verified domain (nothing of ours serves it), or no token in Vault.
  if (!signed) return { ok: false, skipped: true };

  try {
    const res = await fetch(signed.url, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-purge-time": signed.time,
        "x-purge-signature": signed.signature,
        "user-agent": "DayOnePages-Purge/2",
      },
      body: JSON.stringify({ host: signed.host }),
    });
    if (!res.ok) {
      // 404 = a signature the server didn't take: another PURGE_TOKEN in its config.php, or clocks over 2 min apart.
      return { ok: false, skipped: false, error: res.status === 404 ? "signature rejected" : `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { purged?: number };
    return { ok: true, purged: data.purged ?? 0 };
  } catch (cause) {
    const msg = cause instanceof Error ? (cause.name === "TimeoutError" ? "timed out" : cause.message) : "failed";
    return { ok: false, skipped: false, error: msg };
  }
}
