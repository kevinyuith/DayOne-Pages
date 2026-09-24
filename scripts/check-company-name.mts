/**
 * Confere o companyName() do painel com os mesmos casos que o PHP testa
 * (server/tests/company-names.json). `npm run check:company-name`.
 */
import { readFileSync } from "node:fs";
import { companyName } from "../src/lib/pages/company-name.ts";

const cases: [string, string][] = JSON.parse(readFileSync(new URL("../server/tests/company-names.json", import.meta.url), "utf8"));
let failed = 0;
for (const [legal, expected] of cases) {
  const got = companyName(legal);
  if (got !== expected) {
    failed++;
    console.log(`FALHA ${JSON.stringify(legal)} → ${JSON.stringify(got)} (esperado ${JSON.stringify(expected)})`);
  }
}
console.log(`${cases.length - failed} ok, ${failed} falhas`);
process.exit(failed ? 1 : 0);
