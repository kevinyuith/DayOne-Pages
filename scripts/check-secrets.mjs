#!/usr/bin/env node
/**
 * Proof that no secret ended up in the browser bundle.
 *
 * Runs AFTER `next build`: reads the values of the sensitive variables from the
 * environment/.env.local and looks for each one inside `.next/static/`. If it
 * finds one, it fails — because then the secret is in a file any visitor downloads.
 *
 * The project's three guards (no NEXT_PUBLIC_ prefix, `typeof window` in the
 * server modules, and this grep) complement each other: only this one is PROOF.
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
  console.error(`check:secrets: ${STATIC_DIR} does not exist. Run \`next build\` first.`);
  process.exit(2);
}

const values = SECRETS.map((name) => [name, process.env[name]]).filter(([, v]) => v && v.length >= 8);
if (values.length === 0) {
  console.warn("check:secrets: no sensitive variable set; nothing to check.");
  process.exit(0);
}

let leaked = 0;
for (const file of walk(STATIC_DIR)) {
  const text = readFileSync(file, "latin1");
  for (const [name, value] of values) {
    if (text.includes(value)) {
      console.error(`LEAKED: ${name} appears in ${file}`);
      leaked++;
    }
  }
}

if (leaked > 0) process.exit(1);
console.log(`check:secrets: ok (${values.length} secret(s) checked, none found in .next/static).`);
