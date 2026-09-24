/**
 * Purge instantâneo: manda o servidor de entrega esquecer as rotas de um host.
 *
 * O servidor guarda as rotas de cada host em cache (CACHE_TTL, 30 s por
 * padrão). Sem purge, pausar ou remover um domínio só vale quando o cache
 * vence. Com purge, a próxima request já vai ao Supabase e vê o estado novo.
 *
 * Bate em ORIGIN_URL/_purge com o header X-Purge-Token (igual ao PURGE_TOKEN
 * do server/.env). Sem ORIGIN_URL ou PURGE_TOKEN aqui, não faz nada: o
 * servidor responderia 404 de qualquer jeito.
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
      // 404 aqui quase sempre é token diferente do server/.env (o servidor não confirma a rota).
      return { ok: false, skipped: false, error: res.status === 404 ? "token rejected or wrong ORIGIN_URL" : `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { purged?: number };
    return { ok: true, purged: data.purged ?? 0 };
  } catch (cause) {
    const msg = cause instanceof Error ? (cause.name === "TimeoutError" ? "timed out" : cause.message) : "failed";
    return { ok: false, skipped: false, error: msg };
  }
}
