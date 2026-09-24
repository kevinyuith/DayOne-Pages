"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { purgeHost } from "@/lib/origin/purge";
import { loadFunnelWeights, writeFunnelWeights } from "@/lib/pages/funnel-weights";
import { isValidSlug, normalizePath } from "@/lib/pages/normalize";
import { STARTER_HTML } from "@/lib/pages/starter-template";
import { evenSplit, normalizeShares, setShare } from "@/lib/pages/traffic";
import { isPageStatus } from "@/lib/pages/types";
import { supabaseService } from "@/lib/supabase/service";
import type { SaveEditorInput, SaveEditorResult } from "../templates/actions";

/**
 * Actions for the Funnel screen and the funnel page editor. The pages live in
 * pages.funnels (one row per dayone-main funnel, everything in `site`) and are
 * only written through the pages.funnel_* functions.
 *
 * Each page's % (`weight`, always adding up to 100 in the funnel — see traffic.ts)
 * is read live by pages.resolve for the copies on the domains, so changing
 * a % applies to every domain that has the funnel: those domains' server
 * cache is purged so it takes effect immediately (without the purge, within
 * 30 s). Editing the HTML of a library page doesn't change the copies.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const NAME_MIN = 2;
const NAME_MAX = 120;

async function purgeFunnelDomains(funnelId: string): Promise<ActionResult> {
  const { data, error } = await supabaseService().rpc("funnel_domains", { p_funnel: funnelId });
  if (error) throw new Error(error.message);
  const failed: string[] = [];
  for (const { domain } of (data ?? []) as { domain: string }[]) {
    const r = await purgeHost(domain);
    if (!r.ok && !r.skipped) failed.push(domain);
  }
  return failed.length ? fail(`Saved, but the server cache of ${failed.join(", ")} wasn't cleared. It takes effect within 30 s.`) : { ok: true };
}

async function funnelOf(pageId: string): Promise<string | null> {
  const { data, error } = await supabaseService().rpc("funnel_page_find", { p_page: pageId });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

// ── A/B test between the pages ───────────────────────────────────────────────

/** A page's % (0–100) in the funnel's A/B test; the others split the rest in the proportion they had. 0 pauses. */
export async function setPageShare(pageId: string, share: number): Promise<ActionResult> {
  if (!UUID_RE.test(pageId)) return fail("Invalid page.");
  if (!Number.isInteger(share) || share < 0 || share > 100) return fail("The traffic goes from 0 to 100%.");
  try {
    const funnelId = await funnelOf(pageId);
    if (!funnelId) return fail("Page not found.");
    const current = await loadFunnelWeights(funnelId);
    await writeFunnelWeights(funnelId, current, setShare(current, pageId, share));
    revalidatePath("/funnels");
    return purgeFunnelDomains(funnelId);
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Equal shares between the funnel's pages (50/50, 34/33/33…). `funnelId` = pages.funnels row. */
export async function splitFunnelEvenly(funnelId: string): Promise<ActionResult> {
  if (!UUID_RE.test(funnelId)) return fail("Invalid funnel.");
  try {
    const current = await loadFunnelWeights(funnelId);
    await writeFunnelWeights(funnelId, current, evenSplit(Object.keys(current)));
    revalidatePath("/funnels");
    return purgeFunnelDomains(funnelId);
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Copies the whole funnel to the domain: one copy of each page (the ones not
 * archived), tagged with the funnel. On the domain, copies of the same funnel
 * compete for the same URL's traffic by their % (pages.resolve + split_pick).
 * A domain without a default page gets the first one.
 */
export async function copyFunnelToDomain(domainId: string, funnelId: string): Promise<ActionResult<{ copied: number }>> {
  if (!UUID_RE.test(domainId) || !UUID_RE.test(funnelId)) return fail("Choose a domain.");
  try {
    const db = supabaseService();
    const { data, error } = await db.rpc("domain_funnel_copy", { p_domain: domainId, p_funnel: funnelId });
    if (error) {
      if (error.code === "P0002") return fail("Domain not found.");
      throw new Error(error.message);
    }
    const copied = Number(data ?? 0);
    if (!copied) return fail("This funnel has no pages yet.");
    const got = await db.from("domains").select("domain").eq("id", domainId).maybeSingle();
    if (got.error) throw new Error(got.error.message);
    revalidatePath("/funnels");
    revalidatePath("/domains", "layout");
    const domain = (got.data as { domain: string } | null)?.domain;
    const r = domain ? await purgeHost(domain) : null;
    if (r && !r.ok && !r.skipped) return fail(`Copied, but the server cache of ${domain} wasn't cleared. It takes effect within 30 s.`);
    return { ok: true, copied };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Funnel page editor ───────────────────────────────────────────────────────
// Same rules and same response shape as the template actions, so the
// PageEditor doesn't need to know where the page comes from. A slug's id is
// the path itself. The first argument (the pages.funnels row) comes from `.bind()`.

function revalidateFunnelPage(pageId: string) {
  revalidatePath("/funnels");
  revalidatePath(`/funnels/${pageId}`, "layout");
}

/** Saves the page's name/status and (if changed) the current slug's HTML. Zero rows from the database = `conflict`. */
export async function saveFunnelPage(funnelId: string, input: SaveEditorInput): Promise<SaveEditorResult> {
  const { page, slug } = input;
  const name = (page.name ?? "").trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return fail(`Enter a name of ${NAME_MIN} to ${NAME_MAX} characters.`);
  if (!isPageStatus(page.status)) return fail("Invalid status.");
  if (slug && Buffer.byteLength(slug.content, "utf8") > MAX_CONTENT_BYTES) {
    return fail("The HTML exceeds 5 MB. Host images and videos elsewhere and reference them by URL.");
  }
  try {
    const { data, error } = await supabaseService().rpc("funnel_page_save", {
      p_funnel: funnelId,
      p_page: page.id,
      p_name: name,
      p_status: page.status,
      p_expected_page_updated_at: page.expectedUpdatedAt,
      p_slug: slug?.id ?? null,
      p_content: slug?.content ?? null,
      p_expected_slug_updated_at: slug?.expectedUpdatedAt ?? null,
    });
    if (error) throw new Error(error.message);
    const row = (data as { page_updated_at: string; slug_updated_at: string | null; content_hash: string | null }[] | null)?.[0];
    if (!row) return fail("conflict");
    return { ok: true, pageUpdatedAt: row.page_updated_at, slugUpdatedAt: row.slug_updated_at, contentHash: row.content_hash };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function createFunnelSlug(funnelId: string, pageId: string, rawSlug: string, title: string | null): Promise<ActionResult<{ slugId: string }>> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Invalid path. Use lowercase letters, numbers, `-`, `_`, `.` and `/` (e.g. /thank-you).");
  try {
    const { data, error } = await supabaseService().rpc("funnel_slug_create", { p_funnel: funnelId, p_page: pageId, p_slug: slug, p_title: title?.trim() || null, p_content: STARTER_HTML });
    if (error) {
      if (error.code === "23505") return fail("This page already has a slug with that path.");
      throw new Error(error.message);
    }
    revalidateFunnelPage(pageId);
    return { ok: true, slugId: String(data) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function renameFunnelSlug(funnelId: string, pageId: string, oldSlug: string, rawSlug: string): Promise<ActionResult<{ slugId: string }>> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Invalid path.");
  try {
    const { data, error } = await supabaseService().rpc("funnel_slug_rename", { p_funnel: funnelId, p_page: pageId, p_old: oldSlug, p_new: slug });
    if (error) {
      if (error.code === "23505") return fail("This page already has a slug with that path.");
      if (error.code === "P0002") return fail("Slug not found.");
      throw new Error(error.message);
    }
    revalidateFunnelPage(pageId);
    return { ok: true, slugId: String(data) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function toggleFunnelSlug(funnelId: string, pageId: string, slug: string, active: boolean): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().rpc("funnel_slug_set_active", { p_funnel: funnelId, p_page: pageId, p_slug: slug, p_active: active });
    if (error) throw new Error(error.message);
    revalidateFunnelPage(pageId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function deleteFunnelSlug(funnelId: string, pageId: string, slug: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const summary = await db.rpc("funnel_pages_summary", { p_funnel_ids: [funnelId] });
    if (summary.error) throw new Error(summary.error.message);
    const page = (summary.data as { page_id: string; slugs: { slug: string }[] }[] | null)?.find((p) => p.page_id === pageId);
    if (!page || !page.slugs.some((s) => s.slug === slug)) return fail("Slug not found.");
    if (page.slugs.length <= 1) return fail("The page needs at least one slug.");
    const { error } = await db.rpc("funnel_slug_delete", { p_funnel: funnelId, p_page: pageId, p_slug: slug });
    if (error) throw new Error(error.message);
    revalidateFunnelPage(pageId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Removes the page from the funnel. The remaining ones add up to 100% again (in
 * the proportion they had). Its copies on the domains stay, but drop out of the
 * draw (without the page in the library, its % is 0).
 */
export async function removeFunnelPage(funnelId: string, pageId: string): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().rpc("funnel_page_remove", { p_funnel: funnelId, p_page: pageId });
    if (error) {
      if (error.code === "P0002") return fail("Page not found.");
      throw new Error(error.message);
    }
    const weights = await loadFunnelWeights(funnelId);
    await writeFunnelWeights(funnelId, weights, normalizeShares(weights));
    revalidatePath("/funnels");
    return purgeFunnelDomains(funnelId);
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
