"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { fetchPublicHtml } from "@/lib/pages/fetch-page";
import { joinFunnelSplit, publishFunnelPage } from "@/lib/pages/funnel-weights";
import { isValidSlug, normalizePath } from "@/lib/pages/normalize";
import { STARTER_HTML } from "@/lib/pages/starter-template";
import { funnelStarterHtml, refreshPageIds } from "@/lib/pages/subpages";
import { FOLDER_MAX_DEPTH, FOLDER_NAME_MAX, cleanFolderName, folderName, isFolderPath, joinFolder, parentFolder } from "@/lib/pages/folders";
import { isPageStatus, isTemplateKind, type PageKind, type PageStatus } from "@/lib/pages/types";
import { supabaseService } from "@/lib/supabase/service";

/**
 * Page, slug and folder actions.
 *
 * Pattern for all of them: validate at the top → write with the service client →
 * `revalidatePath` only on success. They return
 * `{ ok, reason }` instead of throwing. `redirect()` stays OUTSIDE try/catch
 * because it throws a control exception that Next intercepts.
 *
 * `saveEditor` does NOT revalidate on purpose: any revalidation re-renders
 * the current route in the same response, and the editor would get the whole
 * page back on every Cmd+S. The editor updates its own state with what the
 * action returns.
 */

/** The library has two screens: Templates (/templates) and Funnel (/funnels). */
function revalidateLibrary() {
  revalidatePath("/templates", "layout");
  revalidatePath("/funnels", "layout");
}

/** Cap on a slug's HTML. The transport limit is in next.config (8 MB). */
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

const NAME_MIN = 2;
const NAME_MAX = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A slug as it goes into `pages.pages.slugs` (the database fills in content_hash and dates). */
type SlugInput = { title: string | null; content: string; content_type?: string; is_active?: boolean };
type StoredSlugs = Record<string, SlugInput>;

/** A template's slugs (with the HTML). null if it doesn't exist. */
async function templateSlugs(templateId: string): Promise<{ name: string; kind: PageKind; notes: string | null; folder: string | null; slugs: StoredSlugs } | null> {
  const { data, error } = await supabaseService()
    .from("pages")
    .select("name, kind, notes, folder, slugs")
    .eq("id", templateId)
    .eq("scope", "TEMPLATE")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { name: string; kind: PageKind; notes: string | null; folder: string | null; slugs: StoredSlugs } | null) ?? null;
}

/** Copy of the slugs for another page: HTML with new sub-page ids (see duplicatePage), without hash or dates. */
function copySlugs(slugs: StoredSlugs): StoredSlugs {
  return Object.fromEntries(
    Object.entries(slugs).map(([path, s]) => [path, { title: s.title, content: refreshPageIds(s.content ?? ""), content_type: s.content_type, is_active: s.is_active }]),
  );
}

/** `null` for empty/missing; `undefined` for a value that isn't a uuid. */
function optionalId(v: unknown): string | null | undefined {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return UUID_RE.test(s) ? s : undefined;
}

export type CreatePageState = { error?: string; attempt: number };

/** Where a new template's content comes from. `html` covers pasted HTML and HTML fetched from a link. */
const SOURCES = ["blank", "template", "html"] as const;
type CreateSource = (typeof SOURCES)[number];

/**
 * Creates a template, as a draft, in the open folder — or, with `funnel_id` (the
 * dayone-main funnel, Funnel screen), a page of that funnel in
 * pages.funnels, which joins the A/B test with its share:
 * - `blank`: from scratch (starter template, slug `/`; funnel page: Pre Lander +
 *   Lander);
 * - `template`: copies another template with all its slugs (new ids for the
 *   funnel sub-pages, as in Duplicate);
 * - `html`: the pasted HTML, or what "copy from a link" fetched (already with
 *   absolute addresses; `source_url` goes into the notes).
 */
export async function createPage(prev: CreatePageState, fd: FormData): Promise<CreatePageState> {
  const attempt = prev.attempt + 1;
  const name = String(fd.get("name") ?? "").trim();
  const kind = String(fd.get("kind") ?? "OTHER");
  const folder = String(fd.get("folder") ?? "").trim() || null;
  const funnelId = optionalId(fd.get("funnel_id"));
  const source = String(fd.get("source") ?? "blank") as CreateSource;

  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { error: `Enter a name of ${NAME_MIN} to ${NAME_MAX} characters.`, attempt };
  }
  if (!funnelId && !isTemplateKind(kind)) return { error: "Invalid type.", attempt };
  if (folder !== null && !isFolderPath(folder)) return { error: "Invalid folder.", attempt };
  if (funnelId === undefined) return { error: "Invalid funnel.", attempt };
  if (!(SOURCES as readonly string[]).includes(source)) return { error: "Invalid source.", attempt };

  const db = supabaseService();

  // The content, before creating any row.
  let slugs: StoredSlugs;
  let notes: string | null = null;
  if (source === "template") {
    const templateId = optionalId(fd.get("template_id"));
    if (!templateId) return { error: "Choose the template to copy.", attempt };
    let src: Awaited<ReturnType<typeof templateSlugs>>;
    try {
      src = await templateSlugs(templateId);
    } catch (cause) {
      return { error: errorReason(cause), attempt };
    }
    if (!src || Object.keys(src.slugs).length === 0) return { error: "Template not found.", attempt };
    slugs = copySlugs(src.slugs);
  } else if (source === "html") {
    const content = String(fd.get("content") ?? "");
    if (!content.trim()) return { error: "Paste the HTML (or fetch the page by its link) before creating.", attempt };
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
      return { error: "The HTML is over 5 MB. Host images and videos elsewhere and reference them by URL.", attempt };
    }
    slugs = { "/": { title: name, content } };
    const sourceUrl = String(fd.get("source_url") ?? "").trim();
    if (/^https?:\/\//i.test(sourceUrl)) notes = `Copied from ${sourceUrl.slice(0, 500)}`;
  } else {
    slugs = { "/": { title: name, content: funnelId ? funnelStarterHtml(name) : STARTER_HTML } };
  }

  // Funnel page: goes into the pages.funnels list (the funnel's row is created on first use).
  if (funnelId) {
    let pageId: string;
    try {
      const row = await db.rpc("funnel_for", { p_main_funnel: funnelId });
      if (row.error) {
        if (row.error.code === "23503") return { error: "This funnel no longer exists.", attempt };
        throw new Error(row.error.message);
      }
      const funnelRow = String(row.data);
      const added = await db.rpc("funnel_page_add", { p_funnel: funnelRow, p_name: name, p_slugs: slugs, p_notes: notes });
      if (added.error) throw new Error(added.error.message);
      pageId = String(added.data);
      // A copy of another template is a ready page: it goes in published and joins the A/B test
      // (the published pages' % add up to 100, the others shrink). The other sources start as a
      // draft, which gets no traffic until it is published in the editor.
      if (source === "template" && (await publishFunnelPage(funnelRow, pageId))) await joinFunnelSplit(funnelRow, pageId);
    } catch (cause) {
      return { error: errorReason(cause), attempt };
    }
    revalidatePath("/funnels", "layout");
    redirect(`/funnels/${pageId}/edit`);
  }

  let pageId: string;
  try {
    const { data, error } = await db.from("pages").insert({ scope: "TEMPLATE", name, kind, status: "DRAFT", folder, notes, slugs }).select("id").single();
    if (error) throw new Error(error.message);
    pageId = (data as { id: string }).id;
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }

  revalidateLibrary();
  redirect(`/templates/${pageId}/edit`);
}

/** The HTML of a template's `/` slug (or the first one), to become a funnel's Lander or sample. */
export async function templateRootHtml(templateId: string): Promise<ActionResult<{ html: string }>> {
  if (!UUID_RE.test(templateId)) return fail("Choose a template.");
  try {
    const src = await templateSlugs(templateId);
    const paths = Object.keys(src?.slugs ?? {}).sort();
    const root = src ? (src.slugs["/"] ?? src.slugs[paths[0]]) : undefined;
    return root ? { ok: true, html: root.content ?? "" } : fail("Template not found.");
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * "Create template → copy from a link": fetches the page's HTML (public
 * addresses only; see fetch-page.ts). The form adjusts the relative addresses
 * and shows the preview before creating.
 */
export async function fetchTemplateFromUrl(url: string): Promise<ActionResult<{ html: string; finalUrl: string }>> {
  const r = await fetchPublicHtml(url);
  return r.ok ? { ok: true, html: r.html, finalUrl: r.finalUrl } : fail(r.reason);
}

export type SaveEditorInput = {
  page: { id: string; name: string; kind: PageKind; status: PageStatus; expectedUpdatedAt: string };
  slug: { id: string; content: string; expectedUpdatedAt: string } | null;
};

export type SaveEditorResult = ActionResult<{
  pageUpdatedAt: string;
  slugUpdatedAt: string | null;
  contentHash: string | null;
}>;

/**
 * Saves the page header and (if changed) the current slug's content.
 *
 * Optimistic concurrency: pages.page_save requires the `updated_at` the editor
 * loaded (for the page and the slug). Zero rows = someone saved in between;
 * returns `conflict` and the screen decides. Without this, two tabs would
 * silently overwrite each other.
 */
export async function saveEditor(input: SaveEditorInput): Promise<SaveEditorResult> {
  const { page, slug } = input;
  const name = (page.name ?? "").trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return fail(`Enter a name of ${NAME_MIN} to ${NAME_MAX} characters.`);
  if (!isTemplateKind(page.kind)) return fail("Invalid type.");
  if (!isPageStatus(page.status)) return fail("Invalid status.");
  if (slug && Buffer.byteLength(slug.content, "utf8") > MAX_CONTENT_BYTES) {
    return fail("The HTML is over 5 MB. Host images and videos elsewhere and reference them by URL.");
  }

  try {
    const { data, error } = await supabaseService().rpc("page_save", {
      p_page: page.id,
      p_name: name,
      p_kind: page.kind,
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

// A template's slugs. A slug's id is the path itself; the first
// argument (the template) comes from `.bind()` in the editor route.

export async function createSlug(pageId: string, rawSlug: string, title: string | null): Promise<ActionResult<{ slugId: string }>> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Invalid path. Use lowercase letters, numbers, `-`, `_`, `.` and `/` (e.g. /thank-you).");
  try {
    const { data, error } = await supabaseService().rpc("page_slug_create", { p_page: pageId, p_slug: slug, p_title: title?.trim() || null, p_content: STARTER_HTML });
    if (error) {
      if (error.code === "23505") return fail("This page already has a slug with that path.");
      throw new Error(error.message);
    }
    revalidateLibrary();
    return { ok: true, slugId: String(data) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function renameSlug(pageId: string, oldSlug: string, rawSlug: string): Promise<ActionResult<{ slugId: string }>> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Invalid path.");
  try {
    const { data, error } = await supabaseService().rpc("page_slug_rename", { p_page: pageId, p_old: oldSlug, p_new: slug });
    if (error) {
      if (error.code === "23505") return fail("This page already has a slug with that path.");
      if (error.code === "23503") return fail("Domain routes point to this slug. Update the routes before renaming.");
      if (error.code === "P0002") return fail("Slug not found.");
      throw new Error(error.message);
    }
    revalidateLibrary();
    return { ok: true, slugId: String(data) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function toggleSlug(pageId: string, slug: string, active: boolean): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().rpc("page_slug_set_active", { p_page: pageId, p_slug: slug, p_active: active });
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function deleteSlug(pageId: string, slug: string): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().rpc("page_slug_delete", { p_page: pageId, p_slug: slug });
    if (error) {
      if (error.code === "23514") return fail("The page needs at least one slug.");
      if (error.code === "23503") return fail("Domain routes point to this slug. Remove the routes first.");
      if (error.code === "P0002") return fail("Slug not found.");
      throw new Error(error.message);
    }
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Deletes a template. No domain serves a template (they serve their own
 * copies), so the copies don't change; they only lose the source template's
 * name on screen.
 */
export async function deletePage(pageId: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const { error } = await db.from("pages").delete().eq("id", pageId).eq("scope", "TEMPLATE");
    if (error) throw new Error(error.message);
    revalidateLibrary();
    revalidatePath("/domains", "layout");
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── /templates screen cards: rename, move, duplicate ────────────────────────────

export async function renamePage(pageId: string, rawName: string): Promise<ActionResult> {
  const name = rawName.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return fail(`Enter a name of ${NAME_MIN} to ${NAME_MAX} characters.`);
  try {
    const { error } = await supabaseService().from("pages").update({ name }).eq("id", pageId).eq("scope", "TEMPLATE");
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Moves the page into a folder (its path; `null` = root). A folder that had no template yet starts existing. */
export async function movePage(pageId: string, folder: string | null): Promise<ActionResult> {
  if (folder !== null && !isFolderPath(folder)) return fail("Invalid folder.");
  try {
    const { error } = await supabaseService().from("pages").update({ folder }).eq("id", pageId).eq("scope", "TEMPLATE");
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Duplicates the page with all its slugs (same HTML), as a draft, in the same
 * folder. Domains and routes keep pointing to the original. The sub-pages
 * (funnel) get new ids: in server mode the `dop_step` cookie is per path and
 * two slugs with the same step ids would get mixed up.
 */
export async function duplicatePage(pageId: string): Promise<ActionResult<{ pageId: string }>> {
  try {
    const src = await templateSlugs(pageId);
    if (!src) return fail("Page not found.");
    const name = `${src.name} (copy)`.slice(0, NAME_MAX);
    const created = await supabaseService()
      .from("pages")
      .insert({ scope: "TEMPLATE", name, kind: src.kind, status: "DRAFT", notes: src.notes, folder: src.folder, slugs: copySlugs(src.slugs) })
      .select("id")
      .single();
    if (created.error) throw new Error(created.error.message);
    revalidateLibrary();
    return { ok: true, pageId: (created.data as { id: string }).id };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Folders ───────────────────────────────────────────────────────────────────
// A folder is the path its templates keep (pages.pages.folder); there is no
// folder row. A new folder lives on the screen until a template goes into it.
// Renaming, moving and deleting one rewrite its templates' paths in the
// database, in one statement (pages.template_folder_move / _delete).

async function runFolderMove(from: string, to: string): Promise<ActionResult<{ path: string }>> {
  if (!isFolderPath(to)) return fail(`Folders go up to ${FOLDER_MAX_DEPTH} levels.`);
  try {
    const { error } = await supabaseService().rpc("template_folder_move", { p_from: from, p_to: to });
    if (error?.code === "23514") return fail(`A folder can't go inside itself, and folders go up to ${FOLDER_MAX_DEPTH} levels.`);
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true, path: to };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Renames the folder (the last part of its path); its subfolders go along. */
export async function renameFolder(path: string, rawName: string): Promise<ActionResult<{ path: string }>> {
  const name = cleanFolderName(rawName);
  if (!name) return fail(`Enter a name of 1 to ${FOLDER_NAME_MAX} characters, without "/".`);
  if (!isFolderPath(path)) return fail("Invalid folder.");
  return runFolderMove(path, joinFolder(parentFolder(path), name));
}

/** Moves the folder into another one (`null` = the root), with what's inside. */
export async function moveFolder(path: string, parent: string | null): Promise<ActionResult<{ path: string }>> {
  if (!isFolderPath(path) || (parent !== null && !isFolderPath(parent))) return fail("Invalid folder.");
  if (parent === path || parent?.startsWith(`${path}/`)) return fail("A folder can't go inside itself.");
  return runFolderMove(path, joinFolder(parent, folderName(path)));
}

/** Deletes the folder without deleting anything inside: templates and subfolders move up one level. */
export async function deleteFolder(path: string): Promise<ActionResult> {
  if (!isFolderPath(path)) return fail("Invalid folder.");
  try {
    const { error } = await supabaseService().rpc("template_folder_delete", { p_path: path });
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
