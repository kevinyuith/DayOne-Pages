"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { checkDomainHealth } from "@/lib/origin/health";
import { purgeHost } from "@/lib/origin/purge";
import { isValidDomain, normalizeHost } from "@/lib/pages/normalize";
import { rewriteCopyAngle } from "@/lib/pages/copy-angle";
import { PLACEHOLDER_FIELDS, emptyPlaceholders } from "@/lib/pages/placeholders";
import { applyVariation, describeVariation, pickVariation, type VariationOptions, type VariationStats } from "@/lib/pages/variation";
import { isDomainType, type DomainStatus, type DomainType } from "@/lib/pages/types";
import { supabaseService } from "@/lib/supabase/service";

/**
 * Domain actions.
 *
 * Pattern: validate at the top → write with the service client →
 * `revalidatePath` only on success. The rules of the database CHECKs
 * are repeated here so the message is readable; the database is still the
 * guarantee.
 */

function revalidateDomain(id?: string) {
  revalidatePath("/domains");
  if (id) revalidatePath(`/domains/${id}`);
  revalidatePath("/");
}

/**
 * After pausing or activating a domain: purges the server cache so it takes
 * effect immediately. The database write already happened; if the purge fails,
 * the new state takes effect when the cache expires — the message says so.
 */
async function purgeAfterWrite(domain: string, done: string): Promise<ActionResult> {
  const r = await purgeHost(domain);
  if (r.ok || r.skipped) return { ok: true };
  return fail(`${done}, but the server cache wasn't cleared (${r.error}). It takes effect within 30 s.`);
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The pages.domains trigger rejects a page that isn't the
 * domain's (check_violation). On screen this only happens with a stale
 * list (the page was removed in another tab).
 */
function ownPageError(error: { code?: string; message: string }): string | null {
  if (error.code !== CHECK_VIOLATION) return null;
  if (/own pages|pages of this domain|not in site/.test(error.message)) {
    return "That page no longer belongs to this domain (was it removed?). Reload the page.";
  }
  return null;
}

async function domainName(id: string): Promise<string | null> {
  const { data, error } = await supabaseService().from("domains").select("domain").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { domain: string } | null)?.domain ?? null;
}

// ── Domain ─────────────────────────────────────────────────────────────────

export type DomainFormState = { error?: string; success?: string; attempt: number };

export async function addDomain(prev: DomainFormState, fd: FormData): Promise<DomainFormState> {
  const attempt = prev.attempt + 1;
  const domain = normalizeHost(String(fd.get("domain") ?? ""));
  const type = String(fd.get("type") ?? "");
  const templateId = String(fd.get("template_id") ?? "").trim() || null;

  if (!isValidDomain(domain)) {
    return { error: "Invalid domain. Use the format example.com (no http://, no slash, no www).", attempt };
  }
  if (!isDomainType(type)) return { error: "Choose the type: Media Buyer or Vendor.", attempt };
  if (templateId && !UUID_RE.test(templateId)) return { error: "Invalid template.", attempt };

  const db = supabaseService();
  try {
    const { data, error } = await db.from("domains").insert({ domain, type, status: "ACTIVE", placeholders: emptyPlaceholders() }).select("id").single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { error: `${domain} is already registered.`, attempt };
      throw new Error(error.message);
    }
    if (templateId) {
      // The first copy becomes the default page (domain_page_copy does this when there's no default).
      const copy = await db.rpc("domain_page_copy", { p_domain: (data as { id: string }).id, p_template: templateId });
      if (copy.error) {
        revalidateDomain();
        return { error: `${domain} registered, but copying the template failed (${copy.error.message}). Choose the template on the domain's page.`, attempt };
      }
    }
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }

  revalidateDomain();
  return { success: `${domain} registered. Point the DNS and click Verify.`, attempt };
}

/**
 * Registers a host that showed up in the logs unregistered (list on /domains and
 * the Logs' Domain column). Same insert as the form: ACTIVE, default page
 * chosen later. Then links that host's old hits (with and without www.) to
 * the new domain, so the Logs and the dashboard count its history.
 */
export async function registerSeenDomain(host: string): Promise<ActionResult> {
  const domain = normalizeHost(host);
  if (!isValidDomain(domain)) return fail(`${domain || host} isn't a valid domain.`);

  const db = supabaseService();
  try {
    const { data, error } = await db.from("domains").insert({ domain, status: "ACTIVE", placeholders: emptyPlaceholders() }).select("id").single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return fail(`${domain} is already registered.`);
      throw new Error(error.message);
    }
    const id = (data as { id: string }).id;

    const { error: hitsError } = await db.from("hits").update({ domain_id: id }).is("domain_id", null).in("host", [domain, `www.${domain}`]);
    revalidateDomain();
    revalidatePath("/logs");
    if (hitsError) return fail(`${domain} registered, but its old hits weren't linked to it (${hitsError.message}).`);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export type VerifyResult = ActionResult<{ healthy: boolean; via?: "cloudflare" | "direct"; error?: string }>;

export async function verifyDomain(id: string): Promise<VerifyResult> {
  const db = supabaseService();
  try {
    const { data, error } = await db.from("domains").select("domain").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail("Domain not found.");

    const result = await checkDomainHealth((data as { domain: string }).domain);
    const { error: updateError } = await db
      .from("domains")
      .update({
        last_checked_at: new Date().toISOString(),
        last_check_ok: result.ok,
        last_check_error: result.ok ? null : result.error,
      })
      .eq("id", id);
    if (updateError) throw new Error(updateError.message);

    revalidateDomain(id);
    return result.ok ? { ok: true, healthy: true, via: result.via } : { ok: true, healthy: false, error: result.error };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** The domain's default page: one of its pages (domains.site), or none (404). */
// ── Domain pages (domains.site) ────────────────────────────────────────────

/**
 * Copies a template to the domain. The copy belongs to the domain: editing one
 * doesn't change the other. A domain without a default page gets this one as default.
 */
export async function copyTemplateToDomain(domainId: string, templateId: string): Promise<ActionResult<{ pageId: string }>> {
  if (!UUID_RE.test(templateId)) return fail("Choose a template.");
  try {
    const { data, error } = await supabaseService().rpc("domain_page_copy", { p_domain: domainId, p_template: templateId });
    if (error) {
      if (error.code === "P0002") return fail("Template or domain not found.");
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    const domain = await domainName(domainId);
    const purged = domain ? await purgeAfterWrite(domain, "Template copied") : { ok: true as const };
    return purged.ok ? { ok: true, pageId: String(data) } : purged;
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Template variation (visual and, if asked, copy angle) ───────────────────

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const MAX_ANGLE = 2000;

export type VariationInput = VariationOptions & { templateId: string; angle: string };
export type VariationPreview = { contents: Record<string, string>; summary: string[]; name: string };

/**
 * Generates a template variation without saving anything: visual (colors, fonts,
 * corners/shadows, spacing — see variation.ts) and, when an angle is given,
 * the rewritten copy (copy-angle.ts). All of the template's slugs come out
 * with the same parameters. The screen shows the preview and saves with
 * copyTemplateVariation.
 */
export async function previewTemplateVariation(input: VariationInput): Promise<ActionResult<VariationPreview>> {
  const options: VariationOptions = { colors: !!input.colors, fonts: !!input.fonts, shape: !!input.shape, spacing: !!input.spacing };
  const angle = (input.angle ?? "").trim();
  if (!UUID_RE.test(input.templateId)) return fail("Choose a template.");
  if (!Object.values(options).some(Boolean) && !angle) return fail("Check what to vary or write the copy angle.");
  if (angle.length > MAX_ANGLE) return fail(`The copy angle exceeds ${MAX_ANGLE} characters.`);

  const db = supabaseService();
  try {
    const page = await db.from("pages").select("name, slugs").eq("id", input.templateId).eq("scope", "TEMPLATE").maybeSingle();
    if (page.error) throw new Error(page.error.message);
    const template = page.data as { name: string; slugs: Record<string, { content: string }> } | null;
    const slugs = Object.entries(template?.slugs ?? {}).map(([slug, v]) => ({ slug, content: v.content }));
    if (!template || !slugs.length) return fail("Template not found.");

    const params = pickVariation();
    const stats: VariationStats = { colors: 0, fonts: 0, radii: 0, shadows: 0, spacings: 0, families: {} };
    let contents: Record<string, string> = {};
    for (const s of slugs) {
      const r = applyVariation(s.content ?? "", params, options);
      contents[s.slug] = r.html;
      stats.colors += r.stats.colors;
      stats.fonts += r.stats.fonts;
      stats.radii += r.stats.radii;
      stats.shadows += r.stats.shadows;
      stats.spacings += r.stats.spacings;
      stats.families = { ...r.stats.families, ...stats.families };
    }
    const summary = describeVariation(params, options, stats);

    if (angle) {
      const r = await rewriteCopyAngle(contents, angle);
      if (!r.ok) return fail(r.reason);
      contents = r.pages;
      summary.push(`Copy: ${r.rewritten} ${r.rewritten === 1 ? "passage rewritten" : "passages rewritten"} with the new angle.`);
    }

    const name = `${template.name} · variation`.slice(0, 120);
    return { ok: true, contents, summary, name };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Saves to the domain the variation the screen showed (a new, published page). */
export async function copyTemplateVariation(
  domainId: string,
  templateId: string,
  name: string,
  contents: Record<string, string>,
): Promise<ActionResult<{ pageId: string }>> {
  if (!UUID_RE.test(templateId)) return fail("Choose a template.");
  const cleanName = (name ?? "").trim().slice(0, 120);
  if (cleanName.length < 2) return fail("Give the page a name.");
  for (const html of Object.values(contents ?? {})) {
    if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > MAX_CONTENT_BYTES) return fail("One of the slugs exceeds 5 MB.");
  }
  try {
    const { data, error } = await supabaseService().rpc("domain_page_add", {
      p_domain: domainId,
      p_template: templateId,
      p_name: cleanName,
      p_contents: contents,
    });
    if (error) {
      if (error.code === "P0002") return fail("Template or domain not found.");
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    const domain = await domainName(domainId);
    const purged = domain ? await purgeAfterWrite(domain, "Variation copied") : { ok: true as const };
    return purged.ok ? { ok: true, pageId: String(data) } : purged;
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Replaces a domain page's content with a fresh copy of a template. The
 * page stays the same (default and filter still point to it) and
 * keeps its status; the edits made to it are lost.
 */
export async function replaceDomainPage(domainId: string, pageId: string, templateId: string): Promise<ActionResult> {
  if (!UUID_RE.test(templateId)) return fail("Choose a template.");
  try {
    const { error } = await supabaseService().rpc("domain_page_replace", { p_domain: domainId, p_page: pageId, p_template: templateId });
    if (error) {
      if (error.code === "P0002") return fail("Page or template not found.");
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    const domain = await domainName(domainId);
    return domain ? purgeAfterWrite(domain, "Template replaced") : { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Removes a page from the domain. Refuses while it's the default or the filter's page. */
export async function removeDomainPage(domainId: string, pageId: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const dom = await db.from("domains").select("default_page_id, filter_pass_page_id, filter_fail_page_id").eq("id", domainId).maybeSingle();
    if (dom.error) throw new Error(dom.error.message);
    const d = dom.data as { default_page_id: string | null; filter_pass_page_id: string | null; filter_fail_page_id: string | null } | null;
    if (!d) return fail("Domain not found.");
    if (d.default_page_id === pageId) return fail("This is the default page. Choose another one as default before removing it.");
    if (d.filter_pass_page_id === pageId || d.filter_fail_page_id === pageId) return fail("The domain filter uses this page. Change or clear the filter first.");

    const { error } = await db.rpc("domain_page_remove", { p_domain: domainId, p_page: pageId });
    if (error) {
      const own = ownPageError(error);
      if (own) return fail("The page is still in use. Reload the page.");
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Domain details for the placeholders ────────────────────────────────────

export type PlaceholdersFormState = { error?: string; success?: string; attempt: number };

/**
 * Saves the data the {{key}} placeholders use (pages.domains.placeholders).
 * Stores every field in the list, empty ones included: an empty field becomes
 * empty text on the page, never the raw placeholder.
 */
export async function savePlaceholders(domainId: string, prev: PlaceholdersFormState, fd: FormData): Promise<PlaceholdersFormState> {
  const attempt = prev.attempt + 1;
  const values: Record<string, string> = {};
  for (const f of PLACEHOLDER_FIELDS) {
    const v = String(fd.get(f.key) ?? "").trim();
    if (v.length > f.max) return { error: `${f.label}: at most ${f.max} characters.`, attempt };
    values[f.key] = v;
  }
  const email = values["company.email"];
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Invalid email.", attempt };

  try {
    const { data, error } = await supabaseService().from("domains").update({ placeholders: values }).eq("id", domainId).select("domain").single();
    if (error) throw new Error(error.message);
    revalidateDomain(domainId);
    const purged = await purgeAfterWrite((data as { domain: string }).domain, "Details saved");
    return purged.ok ? { success: "Details saved. The domain's pages already use the new values.", attempt } : { error: purged.reason, attempt };
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }
}

const SLUG_RE = /^\/([a-z0-9._~-]+(\/[a-z0-9._~-]+)*)?$/;

/** The domain's allowed slugs (gate_slugs): besides "/", the paths where a clean click goes to the funnel of its sub1. */
export async function saveGateSlugs(domainId: string, slugs: string[]): Promise<ActionResult<{ slugs: string[] }>> {
  if (!UUID_RE.test(domainId)) return fail("Invalid domain.");
  const clean = Array.from(new Set(slugs.map((s) => s.trim()).filter(Boolean))).filter((s) => s !== "/");
  const bad = clean.find((s) => !SLUG_RE.test(s));
  if (bad) return fail(`Invalid slug "${bad}". Use the format /oferta (lowercase, no trailing slash).`);
  try {
    const { data, error } = await supabaseService().from("domains").update({ gate_slugs: clean }).eq("id", domainId).select("domain").single();
    if (error) throw new Error(error.message);
    revalidateDomain(domainId);
    const purged = await purgeAfterWrite((data as { domain: string }).domain, "Allowed slugs saved");
    if (!purged.ok) return purged;
    return { ok: true, slugs: clean };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function setDomainType(id: string, type: DomainType): Promise<ActionResult> {
  if (!UUID_RE.test(id) || !isDomainType(type)) return fail("Invalid type.");
  try {
    const { error } = await supabaseService().from("domains").update({ type }).eq("id", id);
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function setDomainStatus(id: string, status: DomainStatus): Promise<ActionResult> {
  if (status !== "ACTIVE" && status !== "PAUSED") return fail("Invalid status.");
  try {
    const { data, error } = await supabaseService().from("domains").update({ status }).eq("id", id).select("domain").single();
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    return purgeAfterWrite(data.domain, status === "ACTIVE" ? "Domain activated" : "Domain paused");
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function removeDomain(id: string): Promise<ActionResult> {
  try {
    // Its pages are deleted with it (trigger on pages.domains).
    const { data, error } = await supabaseService().from("domains").delete().eq("id", id).select("domain").single();
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    // No warning if the purge fails: the detail screen needs the ok to leave
    // a record that no longer exists. At worst it takes effect when the cache expires.
    await purgeHost(data.domain);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
