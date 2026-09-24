import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetches the HTML of a public page, for "Create template → copy from a
 * link". Runs on the dashboard server.
 *
 * The dashboard has no login, so this fetch can't become a door into the
 * internal network: only http/https, and every host (including those of each
 * redirect, followed one by one) must resolve ONLY to public IPs — no localhost,
 * private network, link-local (AWS metadata at 169.254.169.254) or CGNAT.
 * The DNS rebinding window between the check and the fetch remains; for an
 * internal dashboard, that's acceptable.
 *
 * Limits: 10 s, 5 MB, 5 redirects, HTML responses only.
 */

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export type FetchPageResult = { ok: true; html: string; finalUrl: string } | { ok: false; reason: string };

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

function ipPrivate(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("ff");
}

/** Does the host resolve only to public IPs? */
async function publicHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !ipPrivate(host);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    return addrs.length > 0 && addrs.every((a) => !ipPrivate(a.address));
  } catch {
    return false;
  }
}

/** Reads the body up to MAX_BYTES; null if it goes over. */
async function readCapped(res: Response): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Decodes using the charset from the header or <meta charset> (UTF-8 if none or unknown). */
function decode(bytes: Uint8Array, contentType: string): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const fromMeta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // unknown charset: try the next one
    }
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchPublicHtml(rawUrl: string): Promise<FetchPageResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "Invalid link. Use the full address (https://...)." };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "Only http:// or https:// links." };
    if (url.username || url.password) return { ok: false, reason: "Links with a username/password aren't accepted." };
    if (!(await publicHost(url.hostname))) return { ok: false, reason: `${url.hostname} is not a public address.` };

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      const timeout = cause instanceof Error && cause.name === "TimeoutError";
      return { ok: false, reason: timeout ? "The site took more than 10 s to respond." : `Couldn't reach ${url.hostname}.` };
    }

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { ok: false, reason: `Redirect with no destination (HTTP ${res.status}).` };
      url = new URL(next, url);
      continue;
    }
    if (!res.ok) return { ok: false, reason: `The site returned HTTP ${res.status}.` };

    const type = res.headers.get("content-type") ?? "";
    if (type && !/html/i.test(type)) return { ok: false, reason: `The link is not an HTML page (${type.split(";")[0]}).` };

    const bytes = await readCapped(res);
    if (!bytes) return { ok: false, reason: "The page is larger than 5 MB." };
    const html = decode(bytes, type);
    if (!html.trim()) return { ok: false, reason: "The site returned an empty page." };
    return { ok: true, html, finalUrl: url.toString() };
  }
  return { ok: false, reason: "Too many redirects." };
}
