import { isVendorPlatform, type VendorPlatform } from "./types";

/**
 * A product's checkout links per platform (pages.products.checkout_links):
 * `{ "<PLATFORM>": { "<key>": "<value>" } }`. A vendor page's
 * `{{checkout.<key>}}` is the value of its product on its platform: a checkout
 * URL with the offer and the affiliate, or the bare offer code where the
 * platform takes one (PagAmerican's one-click upsells, `data-pag-offer`).
 *
 * The delivery server gets them from pages.resolve, merged into the route's
 * placeholders, and replaces them like `{{company.*}}` (placeholders.php); the
 * editor preview does the same with checkoutValues(). A key with no value stays
 * as written. The rules here are the database's (products_checkout_links_check)
 * — change one, change the other.
 */

export type CheckoutLinks = Partial<Record<VendorPlatform, Record<string, string>>>;

/** A checkout key: lowercase letter, then letters, digits or _ (at most 40). */
export const CHECKOUT_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const CHECKOUT_LINKS_MAX_PER_PLATFORM = 100;
export const CHECKOUT_LINK_MAX = 2000;

/** Validates checkout links as the database will. */
export function parseCheckoutLinks(raw: unknown): { ok: true; value: CheckoutLinks } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Checkout links must be an object." };
  const value: CheckoutLinks = {};
  for (const [platform, links] of Object.entries(raw)) {
    if (!isVendorPlatform(platform)) return { ok: false, error: `${platform} is not a checkout platform.` };
    if (!links || typeof links !== "object" || Array.isArray(links)) return { ok: false, error: `The ${platform} links must be an object.` };
    const entries = Object.entries(links);
    if (entries.length > CHECKOUT_LINKS_MAX_PER_PLATFORM) return { ok: false, error: `At most ${CHECKOUT_LINKS_MAX_PER_PLATFORM} checkout links per platform.` };
    const out: Record<string, string> = {};
    for (const [key, link] of entries) {
      if (!CHECKOUT_KEY_RE.test(key)) return { ok: false, error: `Invalid checkout key "${key}": a lowercase letter, then letters, digits or _ (at most 40).` };
      if (typeof link !== "string" || link.length > CHECKOUT_LINK_MAX) return { ok: false, error: `The checkout link ${key} must be text of at most ${CHECKOUT_LINK_MAX} characters.` };
      out[key] = link;
    }
    value[platform] = out;
  }
  return { ok: true, value };
}

/** The `checkout.<key>` placeholder values of a vendor page: its product's links on its platform (what pages.resolve merges). */
export function checkoutValues(links: unknown, platform: string | null): Record<string, string> {
  const values: Record<string, string> = {};
  if (!platform || !links || typeof links !== "object" || Array.isArray(links)) return values;
  const own = (links as Record<string, unknown>)[platform];
  if (!own || typeof own !== "object" || Array.isArray(own)) return values;
  for (const [key, link] of Object.entries(own)) {
    if (typeof link === "string") values[`checkout.${key}`] = link;
  }
  return values;
}
