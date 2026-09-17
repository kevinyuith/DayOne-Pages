import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * O cookie de sessão — um valor assinado, e nada mais.
 *
 * NUNCA vai dentro: a senha, o hash, o segredo. VAI: um instante de expiração
 * e um número aleatório, cobertos por HMAC-SHA256 com `DASH_SESSION_SECRET`.
 *
 *     <corpo em base64url>.<assinatura em base64url>
 *     corpo = {"exp": <epoch ms>, "n": "<aleatório>"}
 *
 * A expiração vai DENTRO da assinatura porque `Max-Age` é instrução para o
 * navegador, não tranca: quem copiou o cookie para um curl reenvia depois de
 * vencido. Com o `exp` assinado, mentir sobre o vencimento exige o segredo.
 *
 * Validade: 12 horas, sem renovação deslizante. Cobre um expediente e vence
 * de madrugada; sessão que se renova sozinha nunca vence.
 *
 * Sem segredo configurado, NADA vale: nem emitir, nem conferir. Com um segredo
 * falso por processo, cada instância assinaria com chave própria e a sessão
 * desligaria sozinha de forma intermitente — o pior tipo de defeito.
 */

if (typeof window !== "undefined") {
  throw new Error("src/lib/auth/cookie.ts foi importado no navegador. Este módulo é do servidor.");
}

export const SESSION_COOKIE = "dayone_pages_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_SECRET_VAR = "DASH_SESSION_SECRET";
const MIN_SECRET_LENGTH = 16;

const FAKE_SECRET = randomBytes(32);

function secret(): Buffer {
  const raw = process.env[SESSION_SECRET_VAR];
  if (!raw || raw.length < MIN_SECRET_LENGTH) return FAKE_SECRET;
  return Buffer.from(raw, "utf8");
}

/** O segredo está configurado? Só para o log do servidor. */
export function secretConfigured(): boolean {
  const raw = process.env[SESSION_SECRET_VAR];
  return Boolean(raw && raw.length >= MIN_SECRET_LENGTH);
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

/** Emite o valor do cookie para uma sessão que começa agora. */
export function issueSession(now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ exp: now + SESSION_TTL_MS, n: randomBytes(9).toString("base64url") }),
    "utf8",
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * O valor é uma sessão válida e não vencida? Booleano e nada mais: o motivo
 * é exatamente o que um atacante gostaria de saber.
 */
export function isValidSession(value: string | undefined | null, now = Date.now()): boolean {
  if (!value) return false;
  if (!secretConfigured()) return false;

  const cut = value.lastIndexOf(".");
  if (cut <= 0 || cut === value.length - 1) return false;

  const body = value.slice(0, cut);
  const received = value.slice(cut + 1);

  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(received, "base64url");
    b = Buffer.from(sign(body), "base64url");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  // Só depois de a assinatura conferir o corpo é lido.
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof payload !== "object" || payload === null) return false;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return false;

  return exp > now;
}

/**
 * As opções do cookie, num lugar só. `secure` é decidido por request em
 * `isSecureRequest`: o navegador só aceita cookie Secure em https ou em
 * localhost. Em `http://192.168.x.x:3000` (rede local) ou num servidor sem
 * TLS, um cookie Secure é descartado em silêncio — a senha é aceita, o
 * redirect acontece e o painel volta para o login como se nada tivesse
 * ocorrido. Foi exatamente esse o sintoma relatado em 17/09/2026.
 */
export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} as const;

/**
 * A request chegou por https (ou é localhost)? Atrás de proxy (Railway,
 * Vercel, Cloudflare, nginx) o protocolo real vem em `x-forwarded-proto`.
 */
export function isSecureRequest(headers: Headers): boolean {
  const proto = headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
  if (proto) return proto === "https";
  const host = headers.get("host") ?? "";
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}
