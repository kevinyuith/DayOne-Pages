"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { purgeHost } from "@/lib/origin/purge";
import { supabaseService } from "@/lib/supabase/service";
import { parseRange } from "@/lib/pages/dashboard-filters";
import { STARTER_HTML } from "@/lib/pages/starter-template";
import { isPageStatus } from "@/lib/pages/types";
import { configChanges, initialConfig, shareProblems, upsellConfigSchema, type UpsellConfig } from "@/lib/pages/upsell-types";
import { getUpsellMetrics, listUpsellVideos, parseConfig, upsellPageInUse, type UpsellMetrics, type UpsellPageOption, type UpsellVideo } from "@/lib/pages/upsell";
import { templateRootHtml, type SaveEditorInput, type SaveEditorResult } from "../templates/actions";

/**
 * The upsell funnels (Upsells menu). The editor works on the DRAFT: every
 * change is saved there (only over the version that was read — `expected` is
 * the funnel's updated_at; NULL back from the database = it changed meanwhile).
 * Publish makes the draft live, keeps it in the history and purges the vendor
 * domains that serve the page (without the purge it takes effect within 30 s).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGED = "The funnel changed meanwhile (another tab?). Reload and redo the change.";

function revalidate(id?: string) {
  revalidatePath("/upsells");
  if (id) revalidatePath(`/upsells/${id}`);
}

/** The names of these upsell pages (the history's summary names the versions by them). */
async function upsellPageNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data, error } = await supabaseService().from("page_content").select("id,name").in("id", ids);
  if (error) throw new Error(error.message);
  return Object.fromEntries(((data as { id: string; name: string }[] | null) ?? []).map((p) => [p.id, p.name]));
}

/** Purges the vendor domains that serve this vendor page (else what they serve changes within 30 s). */
async function purgeVendorPage(vendorPageId: string): Promise<void> {
  const domains = await supabaseService().from("domains").select("domain,page").eq("type", "VENDOR");
  const hosts = ((domains.data as { domain: string; page: Record<string, unknown> }[] | null) ?? [])
    .filter((d) => Object.prototype.hasOwnProperty.call(d.page ?? {}, vendorPageId))
    .map((d) => d.domain);
  await Promise.all(hosts.map((h) => purgeHost(h)));
}

/** The upsell pages a config names. */
function configPageIds(...configs: UpsellConfig[]): string[] {
  const ids = new Set<string>();
  for (const c of configs) for (const s of c.steps) for (const g of s.groups ?? []) for (const list of Object.values(g.pages)) for (const v of list) ids.add(v.page_id);
  return [...ids];
}

/** A new funnel for a vendor page: Upsell 1–3 and the Thank you page, no upsell page chosen yet. */
export async function createUpsellFunnel(pageId: string): Promise<ActionResult<{ id: string }>> {
  if (!UUID_RE.test(pageId)) return fail("Choose a vendor page.");
  const db = supabaseService();
  try {
    const page = await db.from("page_content").select("name").eq("id", pageId).eq("scope", "VENDOR").neq("kind", "UPSELL").maybeSingle();
    if (page.error) throw new Error(page.error.message);
    if (!page.data) return fail("That vendor page no longer exists.");
    const { data, error } = await db.rpc("upsell_funnel_create", {
      p_page: pageId,
      p_name: (page.data as { name: string }).name,
      p_draft: initialConfig(),
      p_by: null,
    });
    if (error) return fail(error.code === "23505" ? "That vendor page already has an upsell funnel." : `Could not create the funnel (${error.message}).`);
    revalidate();
    return { ok: true, id: data as string };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Saves the draft (the whole config; the name too). */
export async function saveUpsellDraft(id: string, config: unknown, name: string | null, expected: string): Promise<ActionResult<{ updatedAt: string }>> {
  if (!UUID_RE.test(id)) return fail("Invalid funnel.");
  const parsed = upsellConfigSchema.safeParse(config);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid funnel.");
  const { data, error } = await supabaseService().rpc("upsell_funnel_draft_save", { p_id: id, p_draft: parsed.data, p_name: name, p_expected: expected });
  if (error) return fail(error.code === "23514" ? `Invalid funnel: ${error.message.replace(/^upsell: /, "")}.` : "Could not save the draft.");
  if (!data) return fail(CHANGED);
  return { ok: true, updatedAt: data as string };
}

/** Drops the draft: the editor goes back to the live config. */
export async function discardUpsellDraft(id: string, expected: string): Promise<ActionResult<{ updatedAt: string }>> {
  if (!UUID_RE.test(id)) return fail("Invalid funnel.");
  const { data, error } = await supabaseService().rpc("upsell_funnel_draft_discard", { p_id: id, p_expected: expected });
  if (error) return fail("Could not discard the draft.");
  if (!data) return fail(CHANGED);
  revalidate(id);
  return { ok: true, updatedAt: data as string };
}

/** Publishes the saved draft: it becomes what the domains serve. Every share list must add up to 100. */
export async function publishUpsellFunnel(id: string, expected: string): Promise<ActionResult<{ updatedAt: string }>> {
  if (!UUID_RE.test(id)) return fail("Invalid funnel.");
  const db = supabaseService();
  try {
    const { data: row, error: readError } = await db.from("upsell_funnels").select("page_id,live,draft,updated_at").eq("id", id).maybeSingle();
    if (readError) throw new Error(readError.message);
    const f = row as { page_id: string; live: unknown; draft: unknown; updated_at: string } | null;
    if (!f) return fail("The funnel no longer exists.");
    if (f.draft === null) return fail("Nothing to publish.");
    const draft = parseConfig(f.draft);
    const problems = shareProblems(draft);
    if (problems.length) return fail(`Shares must add up to 100%: ${problems.join("; ")}.`);
    const live = parseConfig(f.live);
    const summary = configChanges(live, draft, await upsellPageNames(configPageIds(live, draft))).join("; ");
    const { data, error } = await db.rpc("upsell_funnel_publish", { p_id: id, p_expected: expected, p_summary: summary || null, p_by: null });
    if (error) return fail(error.code === "23514" ? `Could not publish: ${error.message.replace(/^upsell: /, "")}.` : `Could not publish (${error.message}).`);
    if (!data) return fail(CHANGED);

    // What the domains serve changed: their cache goes now (else within 30 s).
    await purgeVendorPage(f.page_id);
    revalidate(id);
    return { ok: true, updatedAt: data as string };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Puts a published version back in the draft (publish it to make it live again). */
export async function restoreUpsellVersion(id: string, historyId: number, expected: string): Promise<ActionResult<{ updatedAt: string }>> {
  if (!UUID_RE.test(id) || !Number.isInteger(historyId)) return fail("Invalid version.");
  const { data, error } = await supabaseService().rpc("upsell_funnel_restore", { p_id: id, p_history: historyId, p_expected: expected });
  // 23514: the version names a page that is no longer an upsell page of this product and platform (or an older shape).
  if (error) return fail(error.code === "23514" ? `That version can't be restored: ${error.message.replace(/^upsell: /, "")}.` : "Could not restore that version.");
  if (!data) return fail(CHANGED);
  revalidate(id);
  return { ok: true, updatedAt: data as string };
}

// ── Videos uploaded to VTurb (the VSL stage) ─────────────────────────────────
// The browser puts the file in Storage (media/upsells/<funnel>/…) through a signed upload URL; the
// queued job is dayone-main's VTurb worker's (pages.upsell_videos): it uploads it to VTurb, creates
// the default player in the folder Vendor and records the player id.

/** The video types VTurb takes from here, and their extension. */
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
const MAX_VIDEO_BYTES = 5 * 1024 ** 3;
const STEP_RE = /^up[1-5]$/;
const GROUP_RE = /^g[a-z0-9]{1,12}$/;

/** Where the browser uploads the file: a signed upload URL for a new object of this funnel. */
export async function startUpsellVideoUpload(funnelId: string, size: number, type: string): Promise<ActionResult<{ path: string; url: string }>> {
  if (!UUID_RE.test(funnelId)) return fail("Invalid funnel.");
  const ext = VIDEO_TYPES[type];
  if (!ext) return fail("Upload an MP4, MOV or WebM video.");
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VIDEO_BYTES) return fail("The video must be at most 5 GB.");
  const path = `upsells/${funnelId.toLowerCase()}/${randomUUID()}.${ext}`;
  const { data, error } = await supabaseService().storage.from("media").createSignedUploadUrl(path);
  if (error || !data) return fail("Could not start the upload.");
  return { ok: true, path, url: data.signedUrl };
}

/** The file is in Storage: queue it for VTurb. */
export async function queueUpsellVideo(
  funnelId: string,
  input: { step: string; group: string; name: string; path: string; size: number; type: string },
): Promise<ActionResult<{ id: number }>> {
  if (!UUID_RE.test(funnelId) || !STEP_RE.test(input.step) || !GROUP_RE.test(input.group)) return fail("Invalid upsell step.");
  if (!VIDEO_TYPES[input.type]) return fail("Upload an MP4, MOV or WebM video.");
  const name = input.name.trim().slice(0, 200) || "Upsell video";
  const { data, error } = await supabaseService().rpc("upsell_video_add", {
    p_funnel: funnelId,
    p_step: input.step,
    p_group: input.group,
    p_name: name,
    p_path: input.path,
    p_size: Math.round(input.size),
    p_type: input.type,
    p_by: null,
  });
  if (error) return fail(error.code === "23514" ? `Could not queue the video: ${error.message.replace(/^upsell video: /, "")}.` : "Could not queue the video.");
  if (data === null) return fail("The funnel no longer exists.");
  return { ok: true, id: Number(data) };
}

/** The funnel's uploads (the editor polls it while one is on its way). */
export async function refreshUpsellVideos(funnelId: string): Promise<ActionResult<{ videos: UpsellVideo[] }>> {
  if (!UUID_RE.test(funnelId)) return fail("Invalid funnel.");
  try {
    return { ok: true, videos: await listUpsellVideos(funnelId) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** The editor put the video's player in its group's VSLs: it isn't put back after being removed. */
export async function markUpsellVideoAdded(id: number): Promise<ActionResult> {
  if (!Number.isInteger(id) || id <= 0) return fail("Invalid video.");
  const { error } = await supabaseService().rpc("upsell_video_mark_added", { p_id: id });
  return error ? fail("Could not update the video.") : { ok: true };
}

/** A failed upload goes back to the queue (the worker starts it over). */
export async function retryUpsellVideo(id: number): Promise<ActionResult> {
  if (!Number.isInteger(id) || id <= 0) return fail("Invalid video.");
  const { data, error } = await supabaseService().rpc("upsell_video_retry", { p_id: id });
  if (error) return fail("Could not retry the video.");
  return data ? { ok: true } : fail("Only a failed video can be retried.");
}

// ── The period's numbers ─────────────────────────────────────────────────────

/** The editor's numbers for another period (the Dashboard's ranges: today, 24h, 7d, 30d). */
export async function loadUpsellMetrics(id: string, range: string): Promise<ActionResult<{ metrics: UpsellMetrics }>> {
  if (!UUID_RE.test(id)) return fail("Invalid funnel.");
  try {
    return { ok: true, metrics: await getUpsellMetrics(id, parseRange(range)) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Upsell pages (pages.page_content: scope VENDOR, kind UPSELL) ────────────
// An upsell page is one HTML page at "/", of the funnel's vendor product and platform (the only
// ones its versions can name). It is created PUBLISHED: an upsell page is served as soon as a
// version names it (an archived one is not), so "draft" would only mislead.

const PAGE_NAME_MIN = 2;
const PAGE_NAME_MAX = 120;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export type NewUpsellPageInput =
  | { source: "page"; name: string; pageId: string; slug: string }
  | { source: "template"; name: string; templateId: string }
  | { source: "html"; name: string; content: string; sourceUrl?: string | null }
  | { source: "blank"; name: string };

/** The funnel's vendor page: its product and platform (an upsell page must share both). */
async function funnelVendor(funnelId: string): Promise<{ pageId: string; productId: string | null; platform: string | null } | null> {
  const db = supabaseService();
  const f = await db.from("upsell_funnels").select("page_id").eq("id", funnelId).maybeSingle();
  if (f.error) throw new Error(f.error.message);
  const pageId = (f.data as { page_id: string } | null)?.page_id;
  if (!pageId) return null;
  const p = await db.from("page_content").select("product_id,platform").eq("id", pageId).maybeSingle();
  if (p.error) throw new Error(p.error.message);
  const v = p.data as { product_id: string | null; platform: string | null } | null;
  return v ? { pageId, productId: v.product_id, platform: v.platform } : null;
}

/** An upsell page of this funnel's product and platform (the editor's writes check it). */
async function isFunnelUpsellPage(funnelId: string, pageId: string): Promise<boolean> {
  const vendor = await funnelVendor(funnelId);
  if (!vendor) return false;
  const { data, error } = await supabaseService().from("page_content").select("scope,kind,product_id,platform").eq("id", pageId).maybeSingle();
  if (error) throw new Error(error.message);
  const p = data as { scope: string; kind: string; product_id: string | null; platform: string | null } | null;
  return !!p && p.scope === "VENDOR" && p.kind === "UPSELL" && p.product_id === vendor.productId && p.platform === vendor.platform;
}

/**
 * Creates an upsell page for the funnel's product and platform, from one HTML
 * slug of the product's vendor or upsell pages (any platform), the root of a
 * template, pasted/fetched HTML, or the blank page. The editor then puts it in
 * the group's versions.
 */
export async function createUpsellPage(funnelId: string, input: NewUpsellPageInput): Promise<ActionResult<{ page: UpsellPageOption }>> {
  if (!UUID_RE.test(funnelId)) return fail("Invalid funnel.");
  const name = String(input?.name ?? "").trim();
  if (name.length < PAGE_NAME_MIN || name.length > PAGE_NAME_MAX) return fail(`Enter a name of ${PAGE_NAME_MIN} to ${PAGE_NAME_MAX} characters.`);
  const db = supabaseService();
  try {
    const vendor = await funnelVendor(funnelId);
    if (!vendor) return fail("The funnel no longer exists.");
    if (!vendor.productId || !vendor.platform) return fail("The vendor page needs a product and a platform first.");

    let content: string;
    let notes: string | null = null;
    if (input.source === "page") {
      if (!UUID_RE.test(input.pageId)) return fail("Choose the page to copy.");
      const src = await db.from("page_content").select("name,scope,product_id").eq("id", input.pageId).maybeSingle();
      if (src.error) throw new Error(src.error.message);
      const s = src.data as { name: string; scope: string; product_id: string | null } | null;
      if (!s || s.scope !== "VENDOR" || s.product_id !== vendor.productId) return fail("That page is not one of this product's.");
      const got = await db.rpc("page_slug_get", { p_page: input.pageId, p_slug: String(input.slug ?? "") });
      if (got.error) throw new Error(got.error.message);
      const html = (got.data as { content: string }[] | null)?.[0]?.content;
      if (html === undefined) return fail("That slug no longer exists.");
      content = html;
      notes = `Copied from ${s.name} ${input.slug}`.slice(0, 500);
    } else if (input.source === "template") {
      const r = await templateRootHtml(String(input.templateId ?? ""));
      if (!r.ok) return fail(r.reason);
      content = r.html;
    } else if (input.source === "html") {
      content = String(input.content ?? "");
      if (!content.trim()) return fail("Paste the HTML (or fetch the page by its link) before creating.");
      const url = String(input.sourceUrl ?? "").trim();
      if (/^https?:\/\//i.test(url)) notes = `Copied from ${url.slice(0, 500)}`;
    } else if (input.source === "blank") {
      content = STARTER_HTML;
    } else {
      return fail("Invalid source.");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) return fail("The HTML is over 5 MB. Host images and videos elsewhere and reference them by URL.");

    const { data, error } = await db
      .from("page_content")
      .insert({
        scope: "VENDOR",
        kind: "UPSELL",
        name,
        status: "PUBLISHED",
        product_id: vendor.productId,
        platform: vendor.platform,
        notes,
        slugs: { "/": { title: name, content } },
      })
      .select("id,name,status")
      .single();
    if (error) return fail(error.code === "23514" ? "That page can't be an upsell page of this product." : `Could not create the page (${error.message}).`);
    return { ok: true, page: data as UpsellPageOption };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * The page editor's save for an upsell page (pages.page_save with optimistic
 * concurrency, like every page). Its kind stays UPSELL. A content change purges
 * the funnel's vendor domains: a version that names the page shows it at once.
 */
export async function saveUpsellPage(funnelId: string, input: SaveEditorInput): Promise<SaveEditorResult> {
  const { page, slug } = input;
  const name = (page.name ?? "").trim();
  if (!UUID_RE.test(funnelId) || !UUID_RE.test(page.id)) return fail("Invalid page.");
  if (name.length < PAGE_NAME_MIN || name.length > PAGE_NAME_MAX) return fail(`Enter a name of ${PAGE_NAME_MIN} to ${PAGE_NAME_MAX} characters.`);
  if (!isPageStatus(page.status)) return fail("Invalid status.");
  if (slug && Buffer.byteLength(slug.content, "utf8") > MAX_CONTENT_BYTES) return fail("The HTML is over 5 MB. Host images and videos elsewhere and reference them by URL.");
  try {
    if (!(await isFunnelUpsellPage(funnelId, page.id))) return fail("This page is not one of the funnel's upsell pages.");
    const { data, error } = await supabaseService().rpc("page_save", {
      p_page: page.id,
      p_name: name,
      p_kind: "UPSELL",
      p_status: page.status,
      p_expected_page_updated_at: page.expectedUpdatedAt,
      p_slug: slug?.id ?? null,
      p_content: slug?.content ?? null,
      p_expected_slug_updated_at: slug?.expectedUpdatedAt ?? null,
    });
    if (error) throw new Error(error.message);
    const row = (data as { page_updated_at: string; slug_updated_at: string | null; content_hash: string | null }[] | null)?.[0];
    if (!row) return fail("conflict");
    const vendor = await funnelVendor(funnelId);
    if (vendor && (slug || page.status === "ARCHIVED")) await purgeVendorPage(vendor.pageId);
    return { ok: true, pageUpdatedAt: row.page_updated_at, slugUpdatedAt: row.slug_updated_at, contentHash: row.content_hash };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Deletes an upsell page no funnel names (live or draft): take it out of the versions first. */
export async function deleteUpsellPage(funnelId: string, pageId: string): Promise<ActionResult> {
  if (!UUID_RE.test(funnelId) || !UUID_RE.test(pageId)) return fail("Invalid page.");
  try {
    if (!(await isFunnelUpsellPage(funnelId, pageId))) return fail("This page is not one of the funnel's upsell pages.");
    if (await upsellPageInUse(pageId)) return fail("A funnel still uses this page (live or in its draft): remove it from the versions first.");
    const { error } = await supabaseService().from("page_content").delete().eq("id", pageId).eq("scope", "VENDOR").eq("kind", "UPSELL");
    if (error) throw new Error(error.message);
    revalidate(funnelId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
