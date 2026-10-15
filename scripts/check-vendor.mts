/**
 * Checks the dashboard's vendor rules against the same cases the PHP side tests
 * and the database applies (server/tests/vendor-cases.json): a vendor page's
 * folder and its steps' paths (vendor-paths.ts ⇄ upsell.php, pages.vendor_page_folder),
 * the aliases a config may list (upsellConfigSchema ⇄ pages.upsell_config_check),
 * the {{product.*}} values (product-values.ts ⇄ pages.product_placeholder_values)
 * and their replacement (placeholders.ts ⇄ placeholders.php). `npm run check:vendor`.
 */
import { readFileSync } from "node:fs";
import { applyPlaceholders, suggestPlaceholders } from "../src/lib/pages/placeholders.ts";
import { productValues } from "../src/lib/pages/product-values.ts";
import { initialConfig, upsellConfigSchema } from "../src/lib/pages/upsell-types.ts";
import { aliasProblem, aliasesProblem, stepPaths, vendorFolder } from "../src/lib/pages/vendor-paths.ts";

type Cases = {
  folders: { slugs: string[]; folder: string }[];
  step_paths: { canonical: string; folder: string; aliases: string[]; paths: string[] }[];
  aliases: { canonical: string; alias: string; ok: boolean }[];
  configs: { steps: { canonical: string; aliases: string[] }[]; ok: boolean }[];
  product_values: { cta: unknown; values: Record<string, string> }[];
  placeholders: { html: string; values: Record<string, string>; expected: string }[];
};
const cases: Cases = JSON.parse(readFileSync(new URL("../server/tests/vendor-cases.json", import.meta.url), "utf8"));

let passed = 0;
let failed = 0;
const same = (name: string, expected: unknown, got: unknown) => {
  const a = JSON.stringify(expected);
  const b = JSON.stringify(got);
  if (a === b) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}: expected ${a}, got ${b}`);
  }
};
const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));

cases.folders.forEach((c, i) => same(`folder ${i}`, c.folder, vendorFolder(c.slugs)));
cases.step_paths.forEach((c, i) => same(`step paths ${i}`, c.paths, stepPaths(c.canonical, c.folder, c.aliases)));
cases.aliases.forEach((c, i) => same(`alias ${i} ${c.alias} on ${c.canonical}`, c.ok, aliasProblem(c.canonical, c.alias) === null));
cases.configs.forEach((c, i) => same(`config ${i}`, c.ok, aliasesProblem(c.steps) === null));
cases.product_values.forEach((c, i) => same(`product values ${i}`, sorted(c.values), sorted(productValues(c.cta))));
cases.placeholders.forEach((c, i) => same(`placeholders ${i}`, c.expected, applyPlaceholders(c.html, c.values)));

// The schema reads the same aliases (an alias on Upsell 1 of the first config; one that another step's path ends with).
const withAlias = initialConfig();
withAlias.steps[0].aliases = ["/bg/up1v2"];
same("schema: a valid alias", true, upsellConfigSchema.safeParse(withAlias).success);
withAlias.steps[1].aliases = ["/bg/up1"];
same("schema: an alias ending with another step's path", false, upsellConfigSchema.safeParse(withAlias).success);

// The editor offers a vendor page's product values when the page has them.
const offered = suggestPlaceholders("kit6", { "product.kit6.price": "$49", "product.kit6.bottles": "6 BOTTLES", "product.name": "X" }).map((o) => o.key);
same("suggest: typing kit6 offers the kit's fields, in order", ["product.kit6.bottles", "product.kit6.price"], offered);
same("suggest: no values, no product keys", false, suggestPlaceholders("product", null).some((o) => o.key.startsWith("product.")));

console.log(`${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
