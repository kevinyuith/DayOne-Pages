import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * A porta — verificação da senha única do dashboard.
 *
 * A senha não existe em lugar nenhum do repositório nem do servidor. O que
 * existe é `DASH_PASSWORD_HASH` (variável só do servidor): um scrypt com o sal
 * junto, gerado por `npm run hash-password`.
 *
 * Formato, em seis campos separados por PONTO:
 *
 *     scrypt.<N>.<r>.<p>.<sal em base64url>.<hash em base64url>
 *
 * Ponto e não `$`: arquivo .env faz expansão de variável, e `$32768` viraria
 * um nome de variável inexistente. O hash chegaria destruído e a senha certa
 * seria recusada sem aviso. Base64url não contém ponto.
 *
 * Por que scrypt: hash de senha precisa ser caro de propósito, em CPU e em
 * memória (~33 MB por tentativa com estes parâmetros). Irrelevante para quem
 * entra uma vez por turno; ruinoso para quem tenta adivinhar.
 *
 * Tempo constante, três armadilhas fechadas:
 *   1. `===` em string para no primeiro byte diferente → `timingSafeEqual`.
 *   2. Sair cedo quando a variável falta vazaria a configuração pelo relógio →
 *      sem configuração válida o scrypt roda assim mesmo, contra uma
 *      especificação falsa, e o resultado é descartado.
 *   3. `configured && timingSafeEqual(...)` teria curto-circuito → a comparação
 *      acontece sempre; o `&&` vem depois.
 */

if (typeof window !== "undefined") {
  throw new Error("src/lib/auth/password.ts foi importado no navegador. Este módulo é do servidor.");
}

export const PASSWORD_HASH_VAR = "DASH_PASSWORD_HASH";

/** Parâmetros do scrypt. Memória = 128 · N · r ≈ 33 MB; `maxmem` precisa ser maior. */
export const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
export const SALT_BYTES = 16;

const SEPARATOR = ".";

type Spec = { N: number; r: number; p: number; salt: Buffer; target: Buffer };

let warnedMalformed = false;

/** Devolve `null` para qualquer coisa que não seja um hash íntegro. */
function parse(raw: string | undefined): Spec | null {
  if (!raw) return null;
  const clean = raw.trim();

  const warn = (why: string) => {
    if (warnedMalformed) return;
    warnedMalformed = true;
    console.error(
      `[acesso] ${PASSWORD_HASH_VAR} está presente mas MALFORMADA (${why}, ${clean.length} caracteres). ` +
        "Nenhuma senha vai ser aceita. Se o valor tem `$`, ele foi comido pela expansão do .env: " +
        "gere outro com `npm run hash-password`.",
    );
  };

  const parts = clean.split(SEPARATOR);
  if (parts.length !== 6) {
    warn(clean.includes("$") ? "formato com `$`, ou valor comido pela expansão do .env" : `${parts.length} campos em vez de 6`);
    return null;
  }
  if (parts[0] !== "scrypt") {
    warn("não começa com `scrypt`");
    return null;
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N < 1024 || r < 1 || p < 1) {
    warn("parâmetro de custo inválido");
    return null;
  }

  let salt: Buffer;
  let target: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64url");
    target = Buffer.from(parts[5], "base64url");
  } catch {
    return null;
  }
  if (salt.length < 8) {
    warn("sal curto demais");
    return null;
  }
  if (target.length !== PARAMS.keylen) {
    warn(`alvo com ${target.length} bytes em vez de ${PARAMS.keylen}`);
    return null;
  }

  return { N, r, p, salt, target };
}

/** Sal e alvo aleatórios, uma vez por processo: existem para gastar o mesmo tempo. */
const FAKE_SPEC: Spec = {
  N: PARAMS.N,
  r: PARAMS.r,
  p: PARAMS.p,
  salt: randomBytes(SALT_BYTES),
  target: randomBytes(PARAMS.keylen),
};

export function derive(password: string, salt: Buffer, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      PARAMS.keylen,
      { N: opts.N, r: opts.r, p: opts.p, maxmem: PARAMS.maxmem },
      (err, key) => (err ? reject(err) : resolve(key as Buffer)),
    );
  });
}

/**
 * A senha confere?
 *
 * `false` para senha errada, variável ausente e variável malformada — as três
 * indistinguíveis de fora. Nunca lança por causa de configuração.
 */
export async function verifyPassword(password: string): Promise<boolean> {
  const configured = parse(process.env[PASSWORD_HASH_VAR]);
  const spec = configured ?? FAKE_SPEC;

  let derived: Buffer;
  try {
    derived = await derive(password, spec.salt, spec);
  } catch {
    return false;
  }

  const equal = timingSafeEqual(derived, spec.target);
  return configured !== null && equal;
}

/** A porta está configurada? Só para o log do servidor. */
export function passwordConfigured(): boolean {
  return parse(process.env[PASSWORD_HASH_VAR]) !== null;
}
