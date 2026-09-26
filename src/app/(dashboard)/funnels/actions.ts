"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { purgeHost } from "@/lib/origin/purge";
import { funnelPageStatus, joinFunnelSplit, loadFunnelWeights, writeFunnelWeights } from "@/lib/pages/funnel-weights";
import { isValidSlug, normalizePath } from "@/lib/pages/normalize";
import { STARTER_HTML } from "@/lib/pages/starter-template";
import { normalizeShares } from "@/lib/pages/traffic";
import { getFunnelVslPanel, searchProducedVsls, type FunnelVslPanel, type ProducedVsl } from "@/lib/pages/queries";
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

/**
 * Saves the % of the funnel's published entries (pages and redirects) at once:
 * only when they add up to exactly 100 and they are exactly the funnel's
 * published entries (one may have been published or unpublished meanwhile).
 * 0 pauses an entry. `funnelId` = pages.funnels row.
 */
export async function saveFunnelShares(funnelId: string, shares: Record<string, number>): Promise<ActionResult> {
  if (!UUID_RE.test(funnelId)) return fail("Invalid funnel.");
  const entries = Object.entries(shares);
  if (entries.some(([id, w]) => !UUID_RE.test(id) || !Number.isInteger(w) || w < 0 || w > 100)) return fail("Each share goes from 0 to 100%.");
  if (entries.reduce((n, [, w]) => n + w, 0) !== 100) return fail("The shares must add up to 100%.");
  try {
    const current = await loadFunnelWeights(funnelId);
    const ids = Object.keys(current);
    if (ids.length !== entries.length || !ids.every((id) => id in shares)) return fail("The funnel's published pages changed. Reload and try again.");
    await writeFunnelWeights(funnelId, current, shares);
    revalidatePath("/funnels");
    return purgeFunnelDomains(funnelId);
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
    const before = await funnelPageStatus(funnelId, page.id);
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
    // Only published pages get traffic: publishing joins the A/B test, unpublishing leaves it.
    const nowPublished = page.status === "PUBLISHED";
    if (nowPublished !== (before === "PUBLISHED")) {
      if (nowPublished) {
        await joinFunnelSplit(funnelId, page.id);
      } else {
        const weights = await loadFunnelWeights(funnelId);
        await writeFunnelWeights(funnelId, weights, normalizeShares(weights));
      }
      revalidatePath("/funnels");
      await purgeFunnelDomains(funnelId);
    }
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

/**
 * A redirect entry of a funnel: a FUNNEL page whose "/" slug 302s to a URL
 * template (content_type text/x-redirect). It lives in the split like a page —
 * its own %, status and copy-to-domain — so it uses funnel_page_add /
 * funnel_page_save. The URL may hold {name} placeholders filled from the
 * visit's query by the delivery server (only what the template names goes).
 */
const REDIRECT_URL_MAX = 2000;

function cleanRedirectUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length > REDIRECT_URL_MAX || !/^https?:\/\//i.test(url) || /[\s<>"']/.test(url)) return null;
  return url;
}

/**
 * Writes a redirect's name and destination, published: a redirect has no
 * content to review, so it is always live — it is paused with 0% traffic.
 * Returns false when the entry changed elsewhere in between.
 */
async function writeRedirect(funnelId: string, pageId: string, name: string, dest: string): Promise<"ok" | "conflict" | "missing"> {
  const db = supabaseService();
  const { data, error } = await db.rpc("funnel_pages_summary", { p_funnel_ids: [funnelId] });
  if (error) throw new Error(error.message);
  const row = ((data as { page_id: string; updated_at: string; redirect: string | null; slugs: { slug: string; updated_at: string }[] }[] | null) ?? []).find((r) => r.page_id === pageId);
  if (!row || row.redirect === null) return "missing";
  const slug = row.slugs.find((sl) => sl.slug === "/");
  const saved = await db.rpc("funnel_page_save", {
    p_funnel: funnelId,
    p_page: pageId,
    p_name: name,
    p_status: "PUBLISHED",
    p_expected_page_updated_at: row.updated_at,
    p_slug: "/",
    p_content: dest,
    p_expected_slug_updated_at: slug?.updated_at ?? null,
  });
  if (saved.error) throw new Error(saved.error.message);
  return ((saved.data as unknown[] | null) ?? []).length === 0 ? "conflict" : "ok";
}

/** New redirect entry, live right away (paused with 0%). Returns its page id. */
export async function createFunnelRedirect(mainFunnelId: string, name: string, url: string): Promise<ActionResult<{ pageId: string }>> {
  const clean = name.trim();
  if (!UUID_RE.test(mainFunnelId)) return fail("Invalid funnel.");
  if (clean.length < NAME_MIN || clean.length > NAME_MAX) return fail(`The name has ${NAME_MIN} to ${NAME_MAX} characters.`);
  const dest = cleanRedirectUrl(url);
  if (!dest) return fail("Enter a full https:// destination (up to 2000 characters, no spaces).");
  try {
    const db = supabaseService();
    const row = await db.rpc("funnel_for", { p_main_funnel: mainFunnelId });
    if (row.error) {
      if (row.error.code === "23503") return fail("This funnel no longer exists.");
      throw new Error(row.error.message);
    }
    const funnelRow = String(row.data);
    const slugs = { "/": { title: clean, content: dest, content_type: "text/x-redirect", is_active: true } };
    const added = await db.rpc("funnel_page_add", { p_funnel: funnelRow, p_name: clean, p_slugs: slugs, p_notes: null });
    if (added.error) throw new Error(added.error.message);
    const pageId = String(added.data);
    // Live right away, then it joins the A/B test (the published entries' % add up to 100, the others shrink).
    if ((await writeRedirect(funnelRow, pageId, clean, dest)) !== "ok") return fail("The redirect was created but couldn't be published. Open it and save again.");
    await joinFunnelSplit(funnelRow, pageId);
    revalidatePath("/funnels");
    const purged = await purgeFunnelDomains(funnelRow);
    return purged.ok ? { ok: true, pageId } : purged;
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Edit a redirect entry: name and destination URL (always live; pause it with 0%). */
export async function saveFunnelRedirect(pageId: string, name: string, url: string): Promise<ActionResult> {
  const clean = name.trim();
  if (!UUID_RE.test(pageId)) return fail("Invalid redirect.");
  if (clean.length < NAME_MIN || clean.length > NAME_MAX) return fail(`The name has ${NAME_MIN} to ${NAME_MAX} characters.`);
  const dest = cleanRedirectUrl(url);
  if (!dest) return fail("Enter a full https:// destination (up to 2000 characters, no spaces).");
  try {
    const funnelId = await funnelOf(pageId);
    if (!funnelId) return fail("Redirect not found.");
    const before = await funnelPageStatus(funnelId, pageId);
    const r = await writeRedirect(funnelId, pageId, clean, dest);
    if (r === "missing") return fail("This entry is not a redirect.");
    if (r === "conflict") return fail("The redirect changed elsewhere. Reload and try again.");
    // A redirect saved while still a draft (made before redirects were always live) goes live and joins the split.
    if (before !== "PUBLISHED") await joinFunnelSplit(funnelId, pageId);
    revalidatePath("/funnels");
    return purgeFunnelDomains(funnelId);
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── The funnel's VSL split (pages.funnels.vsl) ───────────────────────────────

// ── The funnel's VSL split (pages.funnels.vsl) ───────────────────────────────
// The split is ours: saved only here, nothing goes to VTurb. The delivery
// server draws one video per visitor by these shares and puts it in the
// page's A/B VTurb player (server/src/vsl.php); VTurb only plays it.

const VTURB_ID_RE = /^[0-9a-f]{24}$/;

/**
 * Saves the % of every video of the funnel's split (they add up to 100; 0
 * pauses one — a video can join at 0% and wait there). `version` is the split's
 * vsl_updated_at the screen loaded: if someone saved in between, nothing is
 * written. The names come from the saved split or dayone-main's copy of the
 * VTurb library, not from the screen.
 */
export async function saveFunnelVsl(funnelRowId: string, weights: Record<string, number>, version: string | null): Promise<ActionResult> {
  if (!UUID_RE.test(funnelRowId)) return fail("Invalid funnel.");
  const entries = Object.entries(weights);
  if (!entries.length || entries.some(([id, w]) => !VTURB_ID_RE.test(id) || typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 100)) {
    return fail("Each video's share goes from 0 to 100%.");
  }
  if (entries.some(([, w]) => Math.round(w * 100) !== w * 100)) return fail("Use at most 2 decimals.");
  const total = entries.reduce((t, [, w]) => t + w, 0);
  if (Math.abs(total - 100) > 0.001) return fail(`The shares add up to ${Math.round(total * 100) / 100}%. They must add up to 100%.`);
  try {
    const db = supabaseService();
    const row = await db.from("funnels").select("vsl").eq("id", funnelRowId).maybeSingle();
    if (row.error) throw new Error(row.error.message);
    if (!row.data) return fail("Funnel not found.");
    const saved = ((row.data as { vsl: Record<string, { weight: number; name: string | null }> | null }).vsl ?? {}) as Record<string, { weight: number; name: string | null }>;

    const vsl: Record<string, { weight: number; name: string | null }> = {};
    for (const [id, weight] of entries) {
      let name = saved[id]?.name ?? null;
      if (!(id in saved)) {
        const found = await db.rpc("vturb_player_find", { p_player: id });
        if (found.error) throw new Error(found.error.message);
        name = ((found.data as { name: string | null }[] | null) ?? [])[0]?.name ?? null;
      }
      vsl[id] = { weight, name };
    }
    const { data: savedAt, error } = await db.rpc("funnel_vsl_set", { p_funnel: funnelRowId, p_vsl: vsl, p_expected: version });
    if (error?.code === "23514") return fail("The shares must add up to 100%.");
    if (error) throw new Error(error.message);
    // NULL = the split changed since the screen loaded it: nothing was written.
    if (!savedAt) return fail("Someone saved this split since the screen loaded. The list now shows the saved split: make your change again.");
    // The domains with the funnel serve the new split right away (without the purge, within 30 s).
    return purgeFunnelDomains(funnelRowId);
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** A VTurb video by id (to add it to a funnel's split), from dayone-main's copy of the VTurb library. */
export async function findFunnelVideo(playerId: string): Promise<ActionResult<{ id: string; name: string | null }>> {
  const id = playerId.trim().toLowerCase();
  if (!VTURB_ID_RE.test(id)) return fail("A VTurb video id has 24 characters (0-9, a-f).");
  try {
    const { data, error } = await supabaseService().rpc("vturb_player_find", { p_player: id });
    if (error) throw new Error(error.message);
    const found = ((data as { id: string; name: string | null }[] | null) ?? [])[0];
    return found ? { ok: true, id: found.id, name: found.name } : fail("This video isn't in the VTurb library yet. New videos show up within a few minutes.");
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** The finished VSLs of the funnel's niche and language, to add one to its split; `query` narrows them. */
export async function searchFunnelVsls(mainFunnelId: string, query: string): Promise<ActionResult<{ vsls: ProducedVsl[] }>> {
  try {
    return { ok: true, vsls: await searchProducedVsls(mainFunnelId, query.trim().slice(0, 100)) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** A funnel's VSLs tab (loaded when it opens): its split. */
export async function loadFunnelVsls(mainFunnelId: string): Promise<ActionResult<{ panel: FunnelVslPanel }>> {
  try {
    const panel = await getFunnelVslPanel(mainFunnelId);
    return panel ? { ok: true, panel } : fail("Funnel not found.");
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
