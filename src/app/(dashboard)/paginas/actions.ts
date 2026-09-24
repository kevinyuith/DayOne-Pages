"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { fetchPublicHtml } from "@/lib/pages/fetch-page";
import { loadFunnelWeights, writeFunnelWeights } from "@/lib/pages/funnel-weights";
import { isValidSlug, normalizePath } from "@/lib/pages/normalize";
import { STARTER_HTML } from "@/lib/pages/starter-template";
import { funnelStarterHtml, refreshPageIds } from "@/lib/pages/subpages";
import { normalizeShares, setShare } from "@/lib/pages/traffic";
import { isFolderColor, isFolderScope, isPageKind, isPageStatus, type FolderScope, type Page, type PageKind, type PageStatus } from "@/lib/pages/types";
import { supabaseService } from "@/lib/supabase/service";

/**
 * Ações de página, slug e pasta.
 *
 * Padrão de todas: validar no topo → escrever com o client de serviço →
 * `revalidatePath` só em sucesso. Devolvem
 * `{ ok, reason }` em vez de lançar. `redirect()` fica FORA de try/catch
 * porque ele lança uma exceção de controle que o Next intercepta.
 *
 * `saveEditor` NÃO revalida de propósito: qualquer revalidação re-renderiza
 * a rota atual na mesma resposta, e o editor receberia a página inteira de
 * volta a cada Cmd+S. O editor atualiza o próprio estado com o que a action
 * devolve.
 */

/** A biblioteca tem duas telas sobre as mesmas tabelas: Templates (/paginas) e Funil (/funil). */
function revalidateLibrary() {
  revalidatePath("/paginas", "layout");
  revalidatePath("/funil", "layout");
}

/** Teto do HTML de uma slug. O limite do transporte está em next.config (8 MB). */
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

const NAME_MIN = 2;
const NAME_MAX = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `null` para vazio/ausente; `undefined` para valor que não é um uuid. */
function optionalId(v: unknown): string | null | undefined {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return UUID_RE.test(s) ? s : undefined;
}

export type CreatePageState = { error?: string; attempt: number };

/** De onde vem o conteúdo de um template novo. `html` cobre o HTML colado e o trazido por link. */
const SOURCES = ["blank", "template", "html"] as const;
type CreateSource = (typeof SOURCES)[number];

/**
 * Cria um template, como rascunho, na pasta aberta — ou, com `funnel_id`
 * (tela Funnel), uma página daquele funil do dayone-main (kind FUNNEL):
 * - `blank`: do zero (modelo inicial, slug `/`; página de funil: Pre Lander +
 *   Lander);
 * - `template`: copia outro template com todas as slugs (ids novos para as
 *   sub-páginas do funil, como em Duplicar);
 * - `html`: o HTML colado, ou o que "copiar de um link" trouxe (já com os
 *   endereços absolutos; `source_url` vai para as notas).
 */
export async function createPage(prev: CreatePageState, fd: FormData): Promise<CreatePageState> {
  const attempt = prev.attempt + 1;
  const name = String(fd.get("name") ?? "").trim();
  const kind = String(fd.get("kind") ?? "OTHER");
  const folderId = optionalId(fd.get("folder_id"));
  const funnelId = optionalId(fd.get("funnel_id"));
  const source = String(fd.get("source") ?? "blank") as CreateSource;

  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { error: `Enter a name of ${NAME_MIN} to ${NAME_MAX} characters.`, attempt };
  }
  if (!isPageKind(kind)) return { error: "Invalid type.", attempt };
  if (folderId === undefined) return { error: "Invalid folder.", attempt };
  if (funnelId === undefined) return { error: "Invalid funnel.", attempt };
  if (!(SOURCES as readonly string[]).includes(source)) return { error: "Invalid source.", attempt };

  const db = supabaseService();

  // O conteúdo, antes de criar qualquer linha.
  let slugs: { slug: string; title: string | null; content: string; content_type?: string; is_active?: boolean }[];
  let notes: string | null = null;
  if (source === "template") {
    const templateId = optionalId(fd.get("template_id"));
    if (!templateId) return { error: "Choose the template to copy.", attempt };
    const src = await db.from("page_slugs").select("slug, title, content, content_type, is_active").eq("page_id", templateId);
    if (src.error) return { error: src.error.message, attempt };
    if (!src.data || src.data.length === 0) return { error: "Template not found.", attempt };
    slugs = (src.data as { slug: string; title: string | null; content: string; content_type: string; is_active: boolean }[]).map((s) => ({
      ...s,
      content: refreshPageIds(s.content ?? ""),
    }));
  } else if (source === "html") {
    const content = String(fd.get("content") ?? "");
    if (!content.trim()) return { error: "Paste the HTML (or fetch the page by its link) before creating.", attempt };
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
      return { error: "The HTML is over 5 MB. Host images and videos elsewhere and reference them by URL.", attempt };
    }
    slugs = [{ slug: "/", title: name, content }];
    const sourceUrl = String(fd.get("source_url") ?? "").trim();
    if (/^https?:\/\//i.test(sourceUrl)) notes = `Copied from ${sourceUrl.slice(0, 500)}`;
  } else {
    slugs = [{ slug: "/", title: name, content: funnelId ? funnelStarterHtml(name) : STARTER_HTML }];
  }

  let pageId: string;
  try {
    // Página de funil: kind FUNNEL, ligada ao funil e fora das pastas de templates.
    const { data, error } = await db
      .from("pages")
      .insert({ name, kind: funnelId ? "FUNNEL" : kind, status: "DRAFT", folder_id: funnelId ? null : folderId, funnel_id: funnelId, notes })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23503" && funnelId) return { error: "This funnel no longer exists.", attempt };
      throw new Error(error.message);
    }
    pageId = (data as { id: string }).id;

    const { error: slugError } = await db.from("page_slugs").insert(slugs.map((s) => ({ ...s, page_id: pageId })));
    if (slugError) {
      await db.from("pages").delete().eq("id", pageId);
      throw new Error(slugError.message);
    }

    // Teste A/B do funil (os % somam 100): a página nova entra com a parte dela e as outras encolhem na proporção.
    if (funnelId) {
      const weights = await loadFunnelWeights(funnelId);
      await writeFunnelWeights(weights, setShare(weights, pageId, 100 / Object.keys(weights).length));
    }
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }

  revalidateLibrary();
  redirect(`/paginas/${pageId}`);
}

/** O HTML da slug `/` de um template (ou da primeira), para virar Lander ou amostra de um funil. */
export async function templateRootHtml(templateId: string): Promise<ActionResult<{ html: string }>> {
  if (!UUID_RE.test(templateId)) return fail("Choose a template.");
  const { data, error } = await supabaseService().from("page_slugs").select("slug, content").eq("page_id", templateId);
  if (error) return fail(error.message);
  const rows = (data ?? []) as { slug: string; content: string }[];
  const root = rows.find((r) => r.slug === "/") ?? rows[0];
  return root ? { ok: true, html: root.content ?? "" } : fail("Template not found.");
}

/**
 * "Criar template → copiar de um link": busca o HTML da página (só endereço
 * público; ver fetch-page.ts). O formulário ajusta os endereços relativos e
 * mostra o preview antes de criar.
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
 * Salva o cabeçalho da página e (se mudou) o conteúdo da slug atual.
 *
 * Concorrência otimista: o UPDATE exige `updated_at` igual ao que o editor
 * carregou. Zero linhas = alguém salvou no meio; devolve `conflict` e a tela
 * decide. Sem isso, duas abas se sobrescreveriam em silêncio.
 */
export async function saveEditor(input: SaveEditorInput): Promise<SaveEditorResult> {
  const { page, slug } = input;
  const name = (page.name ?? "").trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return fail(`Enter a name of ${NAME_MIN} to ${NAME_MAX} characters.`);
  if (!isPageKind(page.kind)) return fail("Invalid type.");
  if (!isPageStatus(page.status)) return fail("Invalid status.");
  if (slug && Buffer.byteLength(slug.content, "utf8") > MAX_CONTENT_BYTES) {
    return fail("The HTML is over 5 MB. Host images and videos elsewhere and reference them by URL.");
  }

  const db = supabaseService();

  try {
    const { data: pageRow, error: pageError } = await db
      .from("pages")
      .update({ name, kind: page.kind, status: page.status })
      .eq("id", page.id)
      .eq("updated_at", page.expectedUpdatedAt)
      .select("updated_at")
      .maybeSingle();
    if (pageError) throw new Error(pageError.message);
    if (!pageRow) return fail("conflict");

    let slugUpdatedAt: string | null = null;
    let contentHash: string | null = null;
    if (slug) {
      const { data: slugRow, error: slugError } = await db
        .from("page_slugs")
        .update({ content: slug.content })
        .eq("id", slug.id)
        .eq("updated_at", slug.expectedUpdatedAt)
        .select("updated_at, content_hash")
        .maybeSingle();
      if (slugError) throw new Error(slugError.message);
      if (!slugRow) return fail("conflict");
      slugUpdatedAt = (slugRow as { updated_at: string }).updated_at;
      contentHash = (slugRow as { content_hash: string }).content_hash;
    }

    return {
      ok: true,
      pageUpdatedAt: (pageRow as { updated_at: string }).updated_at,
      slugUpdatedAt,
      contentHash,
    };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function createSlug(pageId: string, rawSlug: string, title: string | null): Promise<ActionResult<{ slugId: string }>> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Invalid path. Use lowercase letters, numbers, `-`, `_`, `.` and `/` (e.g. /thank-you).");

  try {
    const { data, error } = await supabaseService()
      .from("page_slugs")
      .insert({ page_id: pageId, slug, title: title?.trim() || null, content: STARTER_HTML })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") return fail("This page already has a slug with that path.");
      throw new Error(error.message);
    }
    revalidateLibrary();
    return { ok: true, slugId: (data as { id: string }).id };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function renameSlug(slugId: string, rawSlug: string): Promise<ActionResult> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Invalid path.");

  const db = supabaseService();
  try {
    const current = await db.from("page_slugs").select("page_id, slug").eq("id", slugId).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data) return fail("Slug not found.");
    const { page_id, slug: oldSlug } = current.data as { page_id: string; slug: string };

    const used = await db.from("domain_routes").select("id", { count: "exact", head: true }).eq("page_id", page_id).eq("slug", oldSlug);
    if ((used.count ?? 0) > 0) return fail("Domain routes point to this slug. Update the routes before renaming.");

    const { error } = await db.from("page_slugs").update({ slug }).eq("id", slugId);
    if (error) {
      if (error.code === "23505") return fail("This page already has a slug with that path.");
      throw new Error(error.message);
    }
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function toggleSlug(slugId: string, active: boolean): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().from("page_slugs").update({ is_active: active }).eq("id", slugId);
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function deleteSlug(slugId: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const current = await db.from("page_slugs").select("page_id, slug").eq("id", slugId).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data) return fail("Slug not found.");
    const { page_id, slug } = current.data as { page_id: string; slug: string };

    const siblings = await db.from("page_slugs").select("id", { count: "exact", head: true }).eq("page_id", page_id);
    if ((siblings.count ?? 0) <= 1) return fail("The page needs at least one slug.");

    const used = await db.from("domain_routes").select("id", { count: "exact", head: true }).eq("page_id", page_id).eq("slug", slug);
    if ((used.count ?? 0) > 0) return fail("Domain routes point to this slug. Remove the routes first.");

    const { error } = await db.from("page_slugs").delete().eq("id", slugId);
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Exclui um template. Nenhum domínio aponta para template (eles servem as
 * próprias cópias em domains.site), então as cópias não mudam; só perdem o
 * nome do template de origem na tela.
 */
export async function deletePage(pageId: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const cur = await db.from("pages").select("funnel_id").eq("id", pageId).maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    const { error } = await db.from("pages").delete().eq("id", pageId);
    if (error) throw new Error(error.message);
    // Página de funil: as que ficaram voltam a somar 100%, na proporção que tinham.
    const funnelId = (cur.data as { funnel_id: string | null } | null)?.funnel_id;
    if (funnelId) {
      const weights = await loadFunnelWeights(funnelId);
      await writeFunnelWeights(weights, normalizeShares(weights));
    }
    revalidateLibrary();
    revalidatePath("/dominios", "layout");
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Cards da tela /paginas: renomear, mover, duplicar ─────────────────────────

export async function renamePage(pageId: string, rawName: string): Promise<ActionResult> {
  const name = rawName.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return fail(`Enter a name of ${NAME_MIN} to ${NAME_MAX} characters.`);
  try {
    const { error } = await supabaseService().from("pages").update({ name }).eq("id", pageId);
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Move a página para uma pasta (`null` = raiz). */
export async function movePage(pageId: string, folderId: string | null): Promise<ActionResult> {
  const target = optionalId(folderId);
  if (target === undefined) return fail("Invalid folder.");
  try {
    const { error } = await supabaseService().from("pages").update({ folder_id: target }).eq("id", pageId);
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Duplica a página com todas as slugs (mesmo HTML), como rascunho, na mesma
 * pasta. Domínios e rotas continuam apontando para a original. As sub-páginas
 * (funil) ganham ids novos: no modo servidor o cookie `dop_step` é por path e
 * duas slugs com os mesmos ids de etapa se confundiriam.
 */
export async function duplicatePage(pageId: string): Promise<ActionResult<{ pageId: string }>> {
  const db = supabaseService();
  try {
    const src = await db.from("pages").select("name, kind, notes, folder_id").eq("id", pageId).maybeSingle();
    if (src.error) throw new Error(src.error.message);
    if (!src.data) return fail("Page not found.");
    const page = src.data as Pick<Page, "name" | "kind" | "notes" | "folder_id">;

    const slugs = await db.from("page_slugs").select("slug, title, content, content_type, is_active").eq("page_id", pageId);
    if (slugs.error) throw new Error(slugs.error.message);

    const name = `${page.name} (copy)`.slice(0, NAME_MAX);
    const created = await db
      .from("pages")
      .insert({ name, kind: page.kind, status: "DRAFT", notes: page.notes, folder_id: page.folder_id })
      .select("id")
      .single();
    if (created.error) throw new Error(created.error.message);
    const newId = (created.data as { id: string }).id;

    const rows = (slugs.data ?? []).map((s) => {
      const row = s as { content: string };
      return { ...(s as object), content: refreshPageIds(row.content ?? ""), page_id: newId };
    });
    if (rows.length > 0) {
      const { error } = await db.from("page_slugs").insert(rows);
      if (error) {
        await db.from("pages").delete().eq("id", newId);
        throw new Error(error.message);
      }
    }
    revalidateLibrary();
    return { ok: true, pageId: newId };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Pastas ────────────────────────────────────────────────────────────────────

const FOLDER_NAME_MAX = 80;

function folderName(raw: string): string | null {
  const name = raw.trim();
  return name.length >= 1 && name.length <= FOLDER_NAME_MAX ? name : null;
}

export async function createFolder(parentId: string | null, rawName: string, scope: FolderScope = "TEMPLATE"): Promise<ActionResult<{ folderId: string }>> {
  const name = folderName(rawName);
  if (!name) return fail(`Enter a name of 1 to ${FOLDER_NAME_MAX} characters.`);
  const parent = optionalId(parentId);
  if (parent === undefined) return fail("Invalid folder.");
  if (!isFolderScope(scope)) return fail("Invalid screen.");
  try {
    const { data, error } = await supabaseService().from("folders").insert({ name, parent_id: parent, scope }).select("id").single();
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true, folderId: (data as { id: string }).id };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function renameFolder(folderId: string, rawName: string): Promise<ActionResult> {
  const name = folderName(rawName);
  if (!name) return fail(`Enter a name of 1 to ${FOLDER_NAME_MAX} characters.`);
  try {
    const { error } = await supabaseService().from("folders").update({ name }).eq("id", folderId);
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function setFolderColor(folderId: string, color: string | null): Promise<ActionResult> {
  if (color !== null && !isFolderColor(color)) return fail("Invalid color.");
  try {
    const { error } = await supabaseService().from("folders").update({ color }).eq("id", folderId);
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Move a pasta para dentro de outra (`null` = raiz). O banco recusa ciclos. */
export async function moveFolder(folderId: string, parentId: string | null): Promise<ActionResult> {
  const parent = optionalId(parentId);
  if (parent === undefined) return fail("Invalid folder.");
  if (parent === folderId) return fail("A folder can't be inside itself.");
  try {
    const { error } = await supabaseService().from("folders").update({ parent_id: parent }).eq("id", folderId);
    if (error) {
      if (error.code === "23514") return fail("A folder can't be inside one of its subfolders (or a folder from the other screen).");
      throw new Error(error.message);
    }
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Exclui a pasta sem apagar nada dentro: páginas e subpastas sobem para a
 * pasta-mãe (ou para a raiz).
 */
export async function deleteFolder(folderId: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const cur = await db.from("folders").select("parent_id").eq("id", folderId).maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    if (!cur.data) return fail("Folder not found.");
    const parent = (cur.data as { parent_id: string | null }).parent_id;

    const up1 = await db.from("pages").update({ folder_id: parent }).eq("folder_id", folderId);
    if (up1.error) throw new Error(up1.error.message);
    const up2 = await db.from("folders").update({ parent_id: parent }).eq("parent_id", folderId);
    if (up2.error) throw new Error(up2.error.message);

    const { error } = await db.from("folders").delete().eq("id", folderId);
    if (error) throw new Error(error.message);
    revalidateLibrary();
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
