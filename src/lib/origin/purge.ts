/**
 * Instant purge: tells the delivery server to forget a host's routes.
 *
 * The server caches each host's routes (CACHE_TTL, 30 s by default). Without
 * a purge, pausing or removing a domain only takes effect when the cache
 * expires. With a purge, the next request goes to Supabase and sees the new state.
 *
 * Hits ORIGIN_URL/_purge with the X-Purge-Token header (same as PURGE_TOKEN
 * in server/.env). Without ORIGIN_URL or PURGE_TOKEN here, it does nothing:
 * the server would answer 404 anyway.
 */

export type PurgeResult = { ok: true; purged: number } | { ok: false; skipped: true } | { ok: false; skipped: false; error: string };

const TIMEOUT_MS = 5_000;

export async function purgeHost(host: string): Promise<PurgeResult> {
  const origin = process.env.ORIGIN_URL?.replace(/\/+$/, "");
  const token = process.env.PURGE_TOKEN;
  if (!origin || !token) return { ok: false, skipped: true };

  try {
    const res = await fetch(`${origin}/_purge`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json", "x-purge-token": token, "user-agent": "DayOnePages-Purge/1" },
      body: JSON.stringify({ host }),
    });
    if (!res.ok) {
      // A 404 here almost always means a token different from server/.env (the server doesn't confirm the route).
      return { ok: false, skipped: false, error: res.status === 404 ? "token rejected or wrong ORIGIN_URL" : `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { purged?: number };
    return { ok: true, purged: data.purged ?? 0 };
  } catch (cause) {
    const msg = cause instanceof Error ? (cause.name === "TimeoutError" ? "timed out" : cause.message) : "failed";
    return { ok: false, skipped: false, error: msg };
  }
}
