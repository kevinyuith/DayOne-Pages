/**
 * A vendor page's `{{product.*}}` placeholders (shared, no imports: scripts/
 * check-vendor.mts runs it under Node): its product's bundles as the CTA shows
 * them (pages.products.cta_placeholders = { product, kits: { "<bottles>":
 * { bottles, supply, image, price, total, full_total, save } } }).
 *
 *   {{product.name}}            cta_placeholders.product ("HONEYPEAKDROPS")
 *   {{product.kit6.price}}      kits["6"].price ("$49"), and so on for every
 *                               kit and field (kit1…kit99)
 *
 * pages.resolve merges the same values (pages.product_placeholder_values) into
 * the placeholders of a vendor page's routes — its upsell steps too — like
 * {{checkout.<key>}}, and the delivery server replaces them (placeholders.php);
 * the editor preview gets them from productValues(). A key with no value stays
 * as written. The rules are the database's — change one, change the other.
 */

export const PRODUCT_KIT_FIELDS = ["bottles", "supply", "image", "price", "total", "full_total", "save"] as const;
export type ProductKitField = (typeof PRODUCT_KIT_FIELDS)[number];

export const PRODUCT_KIT_FIELD_LABELS: Record<ProductKitField, string> = {
  bottles: "bottles",
  supply: "supply",
  image: "image",
  price: "price per bottle",
  total: "total",
  full_total: "full price",
  save: "savings",
};

const KIT_RE = /^[1-9][0-9]?$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `product.*` values of a product's cta_placeholders (what pages.resolve merges). */
export function productValues(ctaPlaceholders: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(ctaPlaceholders)) return out;
  if (typeof ctaPlaceholders.product === "string") out["product.name"] = ctaPlaceholders.product;
  const kits = ctaPlaceholders.kits;
  if (!isObject(kits)) return out;
  for (const [n, kit] of Object.entries(kits)) {
    if (!KIT_RE.test(n) || !isObject(kit)) continue;
    for (const field of PRODUCT_KIT_FIELDS) {
      const value = kit[field];
      if (typeof value === "string") out[`product.kit${n}.${field}`] = value;
    }
  }
  return out;
}
