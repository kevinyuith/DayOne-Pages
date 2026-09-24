/**
 * Checks the dashboard's companyName() against the same cases the PHP side tests
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
    console.log(`FAIL ${JSON.stringify(legal)} → ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
}
console.log(`${cases.length - failed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
