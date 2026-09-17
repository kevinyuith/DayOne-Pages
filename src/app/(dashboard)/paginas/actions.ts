"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { isValidSlug, normalizePath } from "@/lib/pages/normalize";
import { STARTER_HTML } from "@/lib/pages/starter-template";
import { isPageKind, isPageStatus, type PageKind, type PageStatus } from "@/lib/pages/types";
import { supabaseService } from "@/lib/supabase/service";

/**
 * Ações de página e slug.
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

/** Teto do HTML de uma slug. O limite do transporte está em next.config (8 MB). */
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

const NAME_MIN = 2;
const NAME_MAX = 120;

export type CreatePageState = { error?: string; attempt: number };

export async function createPage(prev: CreatePageState, fd: FormData): Promise<CreatePageState> {
  const attempt = prev.attempt + 1;
  const name = String(fd.get("name") ?? "").trim();
  const kind = String(fd.get("kind") ?? "OTHER");

  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { error: `Dê um nome com ${NAME_MIN} a ${NAME_MAX} caracteres.`, attempt };
  }
  if (!isPageKind(kind)) return { error: "Tipo inválido.", attempt };

  const db = supabaseService();

  let pageId: string;
  try {
    const { data, error } = await db.from("pages").insert({ name, kind, status: "DRAFT" }).select("id").single();
    if (error) throw new Error(error.message);
    pageId = (data as { id: string }).id;

    const { error: slugError } = await db
      .from("page_slugs")
      .insert({ page_id: pageId, slug: "/", title: name, content: STARTER_HTML });
    if (slugError) {
      await db.from("pages").delete().eq("id", pageId);
      throw new Error(slugError.message);
    }
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }

  revalidatePath("/paginas");
  redirect(`/paginas/${pageId}`);
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
  if (name.length < NAME_MIN || name.length > NAME_MAX) return fail(`Dê um nome com ${NAME_MIN} a ${NAME_MAX} caracteres.`);
  if (!isPageKind(page.kind)) return fail("Tipo inválido.");
  if (!isPageStatus(page.status)) return fail("Status inválido.");
  if (slug && Buffer.byteLength(slug.content, "utf8") > MAX_CONTENT_BYTES) {
    return fail("O HTML passa de 5 MB. Hospede imagens e vídeos fora e referencie por URL.");
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
  if (!isValidSlug(slug)) return fail("Path inválido. Use letras minúsculas, números, `-`, `_`, `.` e `/` (ex.: /obrigado).");

  try {
    const { data, error } = await supabaseService()
      .from("page_slugs")
      .insert({ page_id: pageId, slug, title: title?.trim() || null, content: STARTER_HTML })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") return fail("Esta página já tem uma slug com esse path.");
      throw new Error(error.message);
    }
    revalidatePath("/paginas", "layout");
    return { ok: true, slugId: (data as { id: string }).id };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function renameSlug(slugId: string, rawSlug: string): Promise<ActionResult> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Path inválido.");

  const db = supabaseService();
  try {
    const current = await db.from("page_slugs").select("page_id, slug").eq("id", slugId).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data) return fail("Slug não encontrada.");
    const { page_id, slug: oldSlug } = current.data as { page_id: string; slug: string };

    const used = await db.from("domain_routes").select("id", { count: "exact", head: true }).eq("page_id", page_id).eq("slug", oldSlug);
    if ((used.count ?? 0) > 0) return fail("Há rotas de domínio apontando para esta slug. Ajuste as rotas antes de renomear.");

    const { error } = await db.from("page_slugs").update({ slug }).eq("id", slugId);
    if (error) {
      if (error.code === "23505") return fail("Esta página já tem uma slug com esse path.");
      throw new Error(error.message);
    }
    revalidatePath("/paginas", "layout");
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function toggleSlug(slugId: string, active: boolean): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().from("page_slugs").update({ is_active: active }).eq("id", slugId);
    if (error) throw new Error(error.message);
    revalidatePath("/paginas", "layout");
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
    if (!current.data) return fail("Slug não encontrada.");
    const { page_id, slug } = current.data as { page_id: string; slug: string };

    const siblings = await db.from("page_slugs").select("id", { count: "exact", head: true }).eq("page_id", page_id);
    if ((siblings.count ?? 0) <= 1) return fail("A página precisa de pelo menos uma slug.");

    const used = await db.from("domain_routes").select("id", { count: "exact", head: true }).eq("page_id", page_id).eq("slug", slug);
    if ((used.count ?? 0) > 0) return fail("Há rotas de domínio apontando para esta slug. Remova as rotas antes.");

    const { error } = await db.from("page_slugs").delete().eq("id", slugId);
    if (error) throw new Error(error.message);
    revalidatePath("/paginas", "layout");
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function deletePage(pageId: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const routes = await db.from("domain_routes").select("id", { count: "exact", head: true }).eq("page_id", pageId);
    if ((routes.count ?? 0) > 0) {
      return fail(`Esta página é usada por ${routes.count} rota(s) de domínio. Remova as rotas antes, ou arquive a página.`);
    }
    // domains.default_page_id é ON DELETE SET NULL: o domínio ficaria sem página padrão.
    const { error } = await db.from("pages").delete().eq("id", pageId);
    if (error) throw new Error(error.message);
    revalidatePath("/paginas");
    revalidatePath("/dominios", "layout");
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
