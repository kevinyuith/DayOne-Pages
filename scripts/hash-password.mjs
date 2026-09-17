#!/usr/bin/env node
/**
 * Gera o valor de DASH_PASSWORD_HASH a partir de uma senha.
 *
 * Uso:
 *   npm run hash-password            → pede a senha no terminal, sem eco
 *   DASH_PASSWORD=... npm run hash-password   → lê da variável (para scripts)
 *
 * Imprime SÓ o hash. A senha não é gravada em lugar nenhum.
 *
 * O formato e os parâmetros são os mesmos de src/lib/auth/password.ts:
 *
 *     scrypt.<N>.<r>.<p>.<sal em base64url>.<hash em base64url>
 *
 * Separador é PONTO, não `$`: arquivo .env faz expansão de variável, e
 * `$32768` viraria uma variável inexistente (vazio). Base64url não contém
 * ponto, então não há colisão.
 */
import { randomBytes, scrypt } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline";

const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;
const MIN_LENGTH = 8;

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      PARAMS.keylen,
      { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: PARAMS.maxmem },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    // Desliga o eco: sobrescreve o que o readline escreveria.
    const write = rl._writeToOutput;
    rl._writeToOutput = function (str) {
      if (str.includes(question)) write.call(this, question);
    };
    rl.question(question, (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    });
  });
}

const fromEnv = process.env.DASH_PASSWORD;
const password = fromEnv ?? (await askHidden("Senha do dashboard: "));

if (!password || password.length < MIN_LENGTH) {
  console.error(`A senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`);
  process.exit(1);
}

const salt = randomBytes(SALT_BYTES);
const hash = await derive(password, salt);
const value = [
  "scrypt",
  PARAMS.N,
  PARAMS.r,
  PARAMS.p,
  salt.toString("base64url"),
  hash.toString("base64url"),
].join(".");

console.log(`DASH_PASSWORD_HASH=${value}`);
