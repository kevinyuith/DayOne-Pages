/**
 * Verificação de domínio: "este domínio chega no nosso servidor?"
 *
 * Atrás do Cloudflare, comparar o registro A não serve — resolve para IPs do
 * Cloudflare. O que serve é bater em `/_health` no próprio domínio e conferir
 * o marcador que o servidor devolve no header `X-DayOne-Pages`, que tem de
 * ser igual ao `SERVER_ID` daqui.
 *
 * Tenta https e depois http (antes de o Cloudflare emitir o certificado, só
 * o http responde). Timeout curto: a tela espera por isto.
 */

export type HealthResult =
  | { ok: true; via: "cloudflare" | "direct" }
  | { ok: false; error: string };

const TIMEOUT_MS = 8_000;

export async function checkDomainHealth(domain: string): Promise<HealthResult> {
  const expected = process.env.SERVER_ID;
  if (!expected) return { ok: false, error: "SERVER_ID is not set in the dashboard." };

  const errors: string[] = [];

  for (const scheme of ["https", "http"] as const) {
    const url = `${scheme}://${domain}/_health`;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "DayOnePages-Check/1" },
      });
      const marker = res.headers.get("x-dayone-pages");
      if (marker === expected) {
        return { ok: true, via: res.headers.get("cf-ray") ? "cloudflare" : "direct" };
      }
      errors.push(
        marker
          ? `${scheme}: server responded with a different SERVER_ID`
          : `${scheme}: HTTP ${res.status} without our server's marker`,
      );
    } catch (cause) {
      const msg = cause instanceof Error ? cause.name === "TimeoutError" ? "timed out" : cause.message : "failed";
      errors.push(`${scheme}: ${msg}`);
    }
  }

  return { ok: false, error: errors.join(" · ").slice(0, 300) };
}
