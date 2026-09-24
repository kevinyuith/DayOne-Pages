/**
 * Domain check: "does this domain reach our server?"
 *
 * Behind Cloudflare, comparing the A record doesn't work — it resolves to
 * Cloudflare IPs. What works is hitting `/_health` on the domain itself and
 * checking the marker the server returns in the `X-DayOne-Pages` header, which
 * must equal the `SERVER_ID` here.
 *
 * Tries https and then http (before Cloudflare issues the certificate, only
 * http responds). Short timeout: the screen waits for this.
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
