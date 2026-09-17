"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { checkDomainHealth } from "@/lib/origin/health";
import { parseConditionsForm } from "@/lib/pages/conditions";
import { isValidDomain, isValidSlug, normalizeHost, normalizePath } from "@/lib/pages/normalize";
import {
  BLOCK_CODES,
  REDIRECT_CODES,
  isMatchType,
  isRouteAction,
  type DomainStatus,
} from "@/lib/pages/types";
import { supabaseService } from "@/lib/supabase/service";

/**
 * Ações de domínio e de rota.
 *
 * Padrão: validar no topo → escrever com o client de serviço →
 * `revalidatePath` só em sucesso. As regras dos CHECKs do banco
 * são repetidas aqui para a mensagem ser legível; o banco continua sendo a
 * garantia.
 */

function revalidateDomain(id?: string) {
  revalidatePath("/dominios");
  if (id) revalidatePath(`/dominios/${id}`);
  revalidatePath("/");
}

const UNIQUE_VIOLATION = "23505";

// ── Domínio ────────────────────────────────────────────────────────────────

export type DomainFormState = { error?: string; success?: string; attempt: number };

export async function addDomain(prev: DomainFormState, fd: FormData): Promise<DomainFormState> {
  const attempt = prev.attempt + 1;
  const domain = normalizeHost(String(fd.get("domain") ?? ""));
  const pageId = String(fd.get("default_page_id") ?? "").trim() || null;

  if (!isValidDomain(domain)) {
    return { error: "Domínio inválido. Use o formato exemplo.com (sem http://, sem barra, sem www).", attempt };
  }

  try {
    const { error } = await supabaseService().from("domains").insert({ domain, status: "ACTIVE", default_page_id: pageId });
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { error: `${domain} já está cadastrado.`, attempt };
      throw new Error(error.message);
    }
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }

  revalidateDomain();
  return { success: `${domain} cadastrado. Aponte o DNS e clique em Verificar.`, attempt };
}

export type VerifyResult = ActionResult<{ healthy: boolean; via?: "cloudflare" | "direct"; error?: string }>;

export async function verifyDomain(id: string): Promise<VerifyResult> {
  const db = supabaseService();
  try {
    const { data, error } = await db.from("domains").select("domain").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail("Domínio não encontrado.");

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

export async function setDefaultPage(id: string, pageId: string | null): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().from("domains").update({ default_page_id: pageId || null }).eq("id", id);
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function setDomainStatus(id: string, status: DomainStatus): Promise<ActionResult> {
  if (status !== "ACTIVE" && status !== "PAUSED") return fail("Status inválido.");
  try {
    const { error } = await supabaseService().from("domains").update({ status }).eq("id", id);
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function removeDomain(id: string): Promise<ActionResult> {
  try {
    // As rotas caem em cascata (FK ON DELETE CASCADE).
    const { error } = await supabaseService().from("domains").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Rotas ──────────────────────────────────────────────────────────────────

export type RouteFormState = { error?: string; savedId?: string; attempt: number };

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Cria ou atualiza uma rota. Os campos vêm do formulário de rota.
 *
 * As mesmas regras de ck_domain_routes_action / ck_domain_routes_pattern /
 * ck_domain_routes_bot_only_block, com mensagem legível.
 */
export async function saveRoute(prev: RouteFormState, fd: FormData): Promise<RouteFormState> {
  const attempt = prev.attempt + 1;
  const routeId = str(fd, "route_id") || null;
  const domainId = str(fd, "domain_id");
  const name = str(fd, "name") || null;
  const priorityRaw = str(fd, "priority");
  const priority = Number.parseInt(priorityRaw, 10);
  const isActive = fd.get("is_active") === "on";
  const matchType = str(fd, "match_type");
  const rawPattern = str(fd, "path_pattern");
  const action = str(fd, "action");
  const pageId = str(fd, "page_id") || null;
  const rawSlug = str(fd, "slug");
  const redirectUrl = str(fd, "redirect_url") || null;
  const statusRaw = str(fd, "status_code");
  const preserveQuery = fd.get("preserve_query") === "on";

  if (!domainId) return { error: "Domínio ausente.", attempt };
  if (!Number.isInteger(priority) || priority < 0 || priority > 100000) return { error: "Prioridade deve ser um inteiro entre 0 e 100000.", attempt };
  if (!isMatchType(matchType)) return { error: "Tipo de casamento inválido.", attempt };
  if (!isRouteAction(action)) return { error: "Ação inválida.", attempt };

  // Path
  let pathPattern: string | null = null;
  if (matchType === "ANY") {
    pathPattern = null;
  } else {
    if (!rawPattern) return { error: "Informe o path (ex.: /promo).", attempt };
    if (matchType === "REGEX") {
      try {
        new RegExp(rawPattern);
      } catch {
        return { error: "Regex inválida.", attempt };
      }
      pathPattern = rawPattern;
    } else {
      pathPattern = normalizePath(rawPattern);
      if (!isValidSlug(pathPattern)) return { error: "Path inválido. Use letras minúsculas, números, `-`, `_`, `.` e `/`.", attempt };
    }
  }

  // Ação
  let slug: string | null = null;
  let statusCode: number | null = null;
  let finalPageId: string | null = null;
  let finalRedirect: string | null = null;

  if (action === "SERVE") {
    if (!pageId) return { error: "Escolha a página a servir.", attempt };
    finalPageId = pageId;
    if (rawSlug) {
      slug = normalizePath(rawSlug);
      if (!isValidSlug(slug)) return { error: "Slug inválida.", attempt };
    }
  } else if (action === "REDIRECT") {
    if (!redirectUrl || !/^https?:\/\/\S+$/i.test(redirectUrl)) return { error: "Informe a URL de destino completa (https://...).", attempt };
    finalRedirect = redirectUrl;
    statusCode = Number.parseInt(statusRaw || "302", 10);
    if (!(REDIRECT_CODES as readonly number[]).includes(statusCode)) return { error: "Código de redirect deve ser 301, 302, 307 ou 308.", attempt };
  } else {
    statusCode = Number.parseInt(statusRaw || "404", 10);
    if (!(BLOCK_CODES as readonly number[]).includes(statusCode)) return { error: "Código de bloqueio deve ser 403, 404, 410 ou 451.", attempt };
  }

  // Condições
  const conditions = parseConditionsForm(fd);
  if (!conditions.ok) return { error: conditions.reason, attempt };
  if (conditions.value.bot && action !== "BLOCK") {
    return { error: "A condição \"só bots\" só pode ser usada com a ação Bloquear.", attempt };
  }

  const db = supabaseService();
  const row = {
    domain_id: domainId,
    name,
    priority,
    is_active: isActive,
    match_type: matchType,
    path_pattern: pathPattern,
    conditions: conditions.value,
    action,
    page_id: finalPageId,
    slug,
    redirect_url: finalRedirect,
    status_code: statusCode,
    preserve_query: preserveQuery,
  };

  try {
    const query = routeId
      ? db.from("domain_routes").update(row).eq("id", routeId).eq("domain_id", domainId).select("id").maybeSingle()
      : db.from("domain_routes").insert(row).select("id").single();
    const { data, error } = await query;
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { error: `Já existe uma rota com prioridade ${priority} neste domínio.`, attempt };
      throw new Error(error.message);
    }
    if (!data) return { error: "Rota não encontrada.", attempt };
    revalidateDomain(domainId);
    return { savedId: (data as { id: string }).id, attempt };
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }
}

export async function deleteRoute(id: string, domainId: string): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().from("domain_routes").delete().eq("id", id).eq("domain_id", domainId);
    if (error) throw new Error(error.message);
    revalidateDomain(domainId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function toggleRoute(id: string, domainId: string, active: boolean): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().from("domain_routes").update({ is_active: active }).eq("id", id).eq("domain_id", domainId);
    if (error) throw new Error(error.message);
    revalidateDomain(domainId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Troca de lugar com a vizinha de cima/baixo. UNIQUE(domain_id, priority) exige a RPC atômica. */
export async function moveRoute(id: string, domainId: string, direction: "up" | "down"): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const { data, error } = await db.from("domain_routes").select("id, priority").eq("domain_id", domainId).order("priority");
    if (error) throw new Error(error.message);
    const list = (data ?? []) as { id: string; priority: number }[];
    const index = list.findIndex((r) => r.id === id);
    if (index < 0) return fail("Rota não encontrada.");
    const neighbor = list[direction === "up" ? index - 1 : index + 1];
    if (!neighbor) return { ok: true };

    const { error: rpcError } = await db.rpc("swap_route_priority", { p_a: id, p_b: neighbor.id });
    if (rpcError) throw new Error(rpcError.message);
    revalidateDomain(domainId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
