import { fail, type ActionResult } from "@/lib/action-result";
import { purgeHost } from "@/lib/origin/purge";
import { supabaseService } from "@/lib/supabase/service";
import { checkoutValues, parseCheckoutLinks } from "./checkout-links";
import { productValues } from "./product-values";

/**
 * Vendor pages (pages.page_content scope VENDOR): the product's own funnel, the
 * vendor side. Server-only; the shared rules are in checkout-links.ts.
 *
 * A vendor page is created like a template (a plain insert with its slugs, plus
 * product_id and platform) and is served by the one VENDOR domain that lists it
 * (pages.domain_list_page). Taking it off the domain or deleting the domain
 * keeps it. Its `{{checkout.<key>}}` are its product's checkout links on its
 * platform, and its `{{product.name}}` / `{{product.kit<N>.<field>}}` its
 * product's bundles (product-values.ts). The vendor's traffic rules are still to
 * be decided: until then a vendor page goes through the same gate as any domain page.
 */

/**
 * A page's vendor placeholders for the editor (preview and suggestions): its
 * product's `checkout.<key>` on its platform and `product.*` — what pages.resolve
 * merges. Empty unless it is a vendor page with a product (no platform: no checkout links).
 */
export async function vendorPlaceholderValues(pageId: string): Promise<Record<string, string>> {
  const db = supabaseService();
  const { data: page, error } = await db.from("page_content").select("scope,product_id,platform").eq("id", pageId).maybeSingle();
  if (error) throw new Error(`vendorPlaceholderValues: ${error.message}`);
  const p = page as { scope: string; product_id: string | null; platform: string | null } | null;
  if (!p || p.scope !== "VENDOR" || !p.product_id) return {};
  const product = await db.from("products").select("checkout_links,cta_placeholders").eq("id", p.product_id).maybeSingle();
  if (product.error) throw new Error(`vendorPlaceholderValues: ${product.error.message}`);
  const row = product.data as { checkout_links: unknown; cta_placeholders: unknown } | null;
  return { ...checkoutValues(row?.checkout_links, p.platform), ...productValues(row?.cta_placeholders) };
}

/**
 * Replaces a product's checkout links, only over the version that was read
 * (`expected` = the product's updated_at; `conflict` when it changed meanwhile),
 * then purges the vendor domains that serve its pages (without the purge the
 * change takes effect within 30 s).
 */
export async function saveProductCheckoutLinks(productId: string, links: unknown, expected: string): Promise<ActionResult<{ updatedAt: string }>> {
  const parsed = parseCheckoutLinks(links);
  if (!parsed.ok) return fail(parsed.error);

  const db = supabaseService();
  const { data, error } = await db.rpc("product_checkout_links_set", { p_product: productId, p_links: parsed.value, p_expected: expected });
  if (error) return fail(error.code === "23514" ? "Invalid checkout links." : "Could not save the checkout links.");
  if (!data) return fail("The product changed meanwhile: reload and redo the change.");

  const pages = await db.from("page_content").select("id").eq("scope", "VENDOR").eq("product_id", productId);
  const ids = new Set(((pages.data as { id: string }[] | null) ?? []).map((p) => p.id));
  if (ids.size > 0) {
    const domains = await db.from("domains").select("domain,page").eq("type", "VENDOR");
    const hosts = ((domains.data as { domain: string; page: Record<string, unknown> }[] | null) ?? [])
      .filter((d) => Object.keys(d.page ?? {}).some((id) => ids.has(id)))
      .map((d) => d.domain);
    await Promise.all(hosts.map((host) => purgeHost(host)));
  }
  return { ok: true, updatedAt: data as string };
}
