#!/usr/bin/env node
/**
 * Prova de que nenhum segredo foi parar no pacote do navegador.
 *
 * Roda DEPOIS de `next build`: lê os valores das variáveis sensíveis do
 * ambiente/.env.local e procura cada um dentro de `.next/static/`. Se achar,
 * falha — porque aí o segredo está num arquivo que qualquer visitante baixa.
 *
 * As três guardas do projeto (sem prefixo NEXT_PUBLIC_, `typeof window` nos
 * módulos de servidor, e este grep) se completam: só esta é PROVA.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const SECRETS = ["SUPABASE_SERVICE_KEY"];
const STATIC_DIR = join(process.cwd(), ".next", "static");

function loadEnvLocal() {
  const file = join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

loadEnvLocal();

if (!existsSync(STATIC_DIR)) {
  console.error(`check:secrets: ${STATIC_DIR} não existe. Rode \`next build\` antes.`);
  process.exit(2);
}

const values = SECRETS.map((name) => [name, process.env[name]]).filter(([, v]) => v && v.length >= 8);
if (values.length === 0) {
  console.warn("check:secrets: nenhuma variável sensível definida; nada a conferir.");
  process.exit(0);
}

let leaked = 0;
for (const file of walk(STATIC_DIR)) {
  const text = readFileSync(file, "latin1");
  for (const [name, value] of values) {
    if (text.includes(value)) {
      console.error(`VAZOU: ${name} aparece em ${file}`);
      leaked++;
    }
  }
}

if (leaked > 0) process.exit(1);
console.log(`check:secrets: ok (${values.length} segredos conferidos, nada em .next/static).`);
