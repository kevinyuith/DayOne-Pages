"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { purgeHost } from "@/lib/origin/purge";
import { isValidSlug, normalizePath } from "@/lib/pages/normalize";
import { STARTER_HTML } from "@/lib/pages/starter-template";
import { isPageKind, isPageStatus } from "@/lib/pages/types";
import { supabaseService } from "@/lib/supabase/service";
import type { SaveEditorInput, SaveEditorResult } from "../../../paginas/actions";

/**
 * O editor aberto numa página do domínio (domains.site). Mesmas regras e
 * mesmo formato de resposta das ações de template (paginas/actions.ts), para
 * o PageEditor não saber de onde a página vem. Aqui o id de uma slug é o
 * próprio path.
 *
 * Diferente dos templates, a página do domínio está no ar: toda escrita
 * limpa o cache do servidor para o domínio (se o purge falhar, vale quando o
 * cache vencer, em até 30 s).
 *
 * As primeiras duas partes de cada assinatura (domínio, página) vêm do
 * `.bind()` na página do editor.
 */

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const NAME_MIN = 2;
const NAME_MAX = 120;

async function purgeDomain(domainId: string): Promise<void> {
  const { data } = await supabaseService().from("domains").select("domain").eq("id", domainId).maybeSingle();
  const domain = (data as { domain: string } | null)?.domain;
  if (domain) await purgeHost(domain);
}

function revalidateDomainPages(domainId: string) {
  revalidatePath(`/dominios/${domainId}`, "layout");
}

async function routesUsingSlug(domainId: string, pageId: string, slug: string): Promise<number> {
  const { count, error } = await supabaseService()
    .from("domain_routes")
    .select("id", { count: "exact", head: true })
    .eq("domain_id", domainId)
    .eq("page_id", pageId)
    .eq("slug", slug);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Salva nome/tipo/status da página e (se mudou) o HTML da slug atual. Zero linhas do banco = `conflict`. */
export async function saveDomainPage(domainId: string, input: SaveEditorInput): Promise<SaveEditorResult> {
  const { page, slug } = input;
  const name = (page.name ?? "").trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return fail(`Enter a name of ${NAME_MIN} to ${NAME_MAX} characters.`);
  if (!isPageKind(page.kind)) return fail("Invalid type.");
  if (!isPageStatus(page.status)) return fail("Invalid status.");
  if (slug && Buffer.byteLength(slug.content, "utf8") > MAX_CONTENT_BYTES) {
    return fail("The HTML exceeds 5 MB. Host images and videos elsewhere and reference them by URL.");
  }

  try {
    const { data, error } = await supabaseService().rpc("domain_page_save", {
      p_domain: domainId,
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
    await purgeDomain(domainId);
    return { ok: true, pageUpdatedAt: row.page_updated_at, slugUpdatedAt: row.slug_updated_at, contentHash: row.content_hash };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function createDomainSlug(domainId: string, pageId: string, rawSlug: string, title: string | null): Promise<ActionResult<{ slugId: string }>> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Invalid path. Use lowercase letters, numbers, `-`, `_`, `.` and `/` (e.g. /thank-you).");
  try {
    const { data, error } = await supabaseService().rpc("domain_slug_create", {
      p_domain: domainId,
      p_page: pageId,
      p_slug: slug,
      p_title: title?.trim() || null,
      p_content: STARTER_HTML,
    });
    if (error) {
      if (error.code === "23505") return fail("This page already has a slug with that path.");
      throw new Error(error.message);
    }
    revalidateDomainPages(domainId);
    await purgeDomain(domainId);
    return { ok: true, slugId: String(data) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function renameDomainSlug(domainId: string, pageId: string, oldSlug: string, rawSlug: string): Promise<ActionResult<{ slugId: string }>> {
  const slug = normalizePath(rawSlug);
  if (!isValidSlug(slug)) return fail("Invalid path.");
  try {
    if ((await routesUsingSlug(domainId, pageId, oldSlug)) > 0) {
      return fail("Domain routes point to this slug. Adjust the routes before renaming.");
    }
    const { data, error } = await supabaseService().rpc("domain_slug_rename", { p_domain: domainId, p_page: pageId, p_old: oldSlug, p_new: slug });
    if (error) {
      if (error.code === "23505") return fail("This page already has a slug with that path.");
      if (error.code === "P0002") return fail("Slug not found.");
      throw new Error(error.message);
    }
    revalidateDomainPages(domainId);
    await purgeDomain(domainId);
    return { ok: true, slugId: String(data) };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function toggleDomainSlug(domainId: string, pageId: string, slug: string, active: boolean): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().rpc("domain_slug_set_active", { p_domain: domainId, p_page: pageId, p_slug: slug, p_active: active });
    if (error) throw new Error(error.message);
    revalidateDomainPages(domainId);
    await purgeDomain(domainId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function deleteDomainSlug(domainId: string, pageId: string, slug: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const summary = await db.rpc("domain_pages_summary", { p_domain_ids: [domainId] });
    if (summary.error) throw new Error(summary.error.message);
    const page = (summary.data as { page_id: string; slugs: { slug: string }[] }[] | null)?.find((p) => p.page_id === pageId);
    if (!page || !page.slugs.some((s) => s.slug === slug)) return fail("Slug not found.");
    if (page.slugs.length <= 1) return fail("The page needs at least one slug.");
    if ((await routesUsingSlug(domainId, pageId, slug)) > 0) return fail("Domain routes point to this slug. Remove the routes first.");

    const { error } = await db.rpc("domain_slug_delete", { p_domain: domainId, p_page: pageId, p_slug: slug });
    if (error) throw new Error(error.message);
    revalidateDomainPages(domainId);
    await purgeDomain(domainId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
