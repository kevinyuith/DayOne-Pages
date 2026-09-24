"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { checkDomainHealth } from "@/lib/origin/health";
import { purgeHost } from "@/lib/origin/purge";
import { parseConditionsForm } from "@/lib/pages/conditions";
import { isValidDomain, isValidSlug, normalizeHost, normalizePath } from "@/lib/pages/normalize";
import { rewriteCopyAngle } from "@/lib/pages/copy-angle";
import { PLACEHOLDER_FIELDS, emptyPlaceholders } from "@/lib/pages/placeholders";
import { applyVariation, describeVariation, pickVariation, type VariationOptions, type VariationStats } from "@/lib/pages/variation";
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

/**
 * Depois de pausar ou ativar um domínio: purga o cache do servidor para
 * valer na hora. A escrita no banco já aconteceu; se o purge falhar, o
 * estado novo vale quando o cache vencer — a mensagem diz isso.
 */
async function purgeAfterWrite(domain: string, done: string): Promise<ActionResult> {
  const r = await purgeHost(domain);
  if (r.ok || r.skipped) return { ok: true };
  return fail(`${done}, mas o cache do servidor não foi limpo (${r.error}). Vale em até 30 s.`);
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Os triggers de pages.domains / domain_routes recusam página que não é do
 * domínio (check_violation). Na tela isso só acontece com a lista
 * desatualizada (a página foi removida em outra aba).
 */
function ownPageError(error: { code?: string; message: string }): string | null {
  if (error.code !== CHECK_VIOLATION) return null;
  if (/own pages|pages of this domain|not in site/.test(error.message)) {
    return "Essa página não é mais deste domínio (foi removida?). Recarregue a tela.";
  }
  return null;
}

async function domainName(id: string): Promise<string | null> {
  const { data, error } = await supabaseService().from("domains").select("domain").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { domain: string } | null)?.domain ?? null;
}

// ── Domínio ────────────────────────────────────────────────────────────────

export type DomainFormState = { error?: string; success?: string; attempt: number };

export async function addDomain(prev: DomainFormState, fd: FormData): Promise<DomainFormState> {
  const attempt = prev.attempt + 1;
  const domain = normalizeHost(String(fd.get("domain") ?? ""));
  const templateId = String(fd.get("template_id") ?? "").trim() || null;

  if (!isValidDomain(domain)) {
    return { error: "Domínio inválido. Use o formato exemplo.com (sem http://, sem barra, sem www).", attempt };
  }
  if (templateId && !UUID_RE.test(templateId)) return { error: "Template inválido.", attempt };

  const db = supabaseService();
  try {
    const { data, error } = await db.from("domains").insert({ domain, status: "ACTIVE", placeholders: emptyPlaceholders() }).select("id").single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { error: `${domain} já está cadastrado.`, attempt };
      throw new Error(error.message);
    }
    if (templateId) {
      // A primeira cópia vira a página padrão (domain_page_copy faz isso quando não há padrão).
      const copy = await db.rpc("domain_page_copy", { p_domain: (data as { id: string }).id, p_template: templateId });
      if (copy.error) {
        revalidateDomain();
        return { error: `${domain} cadastrado, mas a cópia do template falhou (${copy.error.message}). Escolha o template na tela do domínio.`, attempt };
      }
    }
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }

  revalidateDomain();
  return { success: `${domain} cadastrado. Aponte o DNS e clique em Verificar.`, attempt };
}

/**
 * Cadastra um host que apareceu nos logs sem cadastro (lista em /dominios e
 * coluna Domínio dos Logs). Mesmo insert do formulário: ACTIVE, página padrão
 * escolhida depois. Em seguida liga os hits antigos daquele host (com e sem
 * www.) ao domínio novo, para os Logs e o dashboard contarem o histórico dele.
 */
export async function registerSeenDomain(host: string): Promise<ActionResult> {
  const domain = normalizeHost(host);
  if (!isValidDomain(domain)) return fail(`${domain || host} não é um domínio válido.`);

  const db = supabaseService();
  try {
    const { data, error } = await db.from("domains").insert({ domain, status: "ACTIVE", placeholders: emptyPlaceholders() }).select("id").single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return fail(`${domain} já está cadastrado.`);
      throw new Error(error.message);
    }
    const id = (data as { id: string }).id;

    const { error: hitsError } = await db.from("hits").update({ domain_id: id }).is("domain_id", null).in("host", [domain, `www.${domain}`]);
    revalidateDomain();
    revalidatePath("/logs");
    if (hitsError) return fail(`${domain} cadastrado, mas os hits antigos não foram ligados a ele (${hitsError.message}).`);
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

/** Página padrão do domínio: uma das páginas dele (domains.site), ou nenhuma (404). */
export async function setDefaultPage(id: string, pageId: string | null): Promise<ActionResult> {
  try {
    const { data, error } = await supabaseService().from("domains").update({ default_page_id: pageId || null }).eq("id", id).select("domain").single();
    if (error) {
      const own = ownPageError(error);
      if (own) return fail(own);
      throw new Error(error.message);
    }
    revalidateDomain(id);
    return purgeAfterWrite((data as { domain: string }).domain, "Página padrão trocada");
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Páginas do domínio (domains.site) ──────────────────────────────────────

/**
 * Copia um template para o domínio. A cópia é do domínio: editar uma não
 * muda a outra. Domínio sem página padrão ganha esta como padrão.
 */
export async function copyTemplateToDomain(domainId: string, templateId: string): Promise<ActionResult<{ pageId: string }>> {
  if (!UUID_RE.test(templateId)) return fail("Escolha um template.");
  try {
    const { data, error } = await supabaseService().rpc("domain_page_copy", { p_domain: domainId, p_template: templateId });
    if (error) {
      if (error.code === "P0002") return fail("Template ou domínio não encontrado.");
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    const domain = await domainName(domainId);
    const purged = domain ? await purgeAfterWrite(domain, "Template copiado") : { ok: true as const };
    return purged.ok ? { ok: true, pageId: String(data) } : purged;
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Variação do template (visual e, se pedir, ângulo da copy) ───────────────

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const MAX_ANGLE = 2000;

export type VariationInput = VariationOptions & { templateId: string; angle: string };
export type VariationPreview = { contents: Record<string, string>; summary: string[]; name: string };

/**
 * Gera uma variação do template sem gravar nada: visual (cores, fontes,
 * cantos/sombras, espaçamentos — ver variation.ts) e, com um ângulo
 * informado, a copy reescrita (copy-angle.ts). Todas as slugs do template
 * saem com os mesmos parâmetros. A tela mostra o preview e grava com
 * copyTemplateVariation.
 */
export async function previewTemplateVariation(input: VariationInput): Promise<ActionResult<VariationPreview>> {
  const options: VariationOptions = { colors: !!input.colors, fonts: !!input.fonts, shape: !!input.shape, spacing: !!input.spacing };
  const angle = (input.angle ?? "").trim();
  if (!UUID_RE.test(input.templateId)) return fail("Escolha um template.");
  if (!Object.values(options).some(Boolean) && !angle) return fail("Marque o que variar ou escreva o ângulo da copy.");
  if (angle.length > MAX_ANGLE) return fail(`O ângulo da copy passa de ${MAX_ANGLE} caracteres.`);

  const db = supabaseService();
  try {
    const [page, slugs] = await Promise.all([
      db.from("pages").select("name").eq("id", input.templateId).maybeSingle(),
      db.from("page_slugs").select("slug, content").eq("page_id", input.templateId),
    ]);
    if (page.error) throw new Error(page.error.message);
    if (slugs.error) throw new Error(slugs.error.message);
    if (!page.data || !slugs.data?.length) return fail("Template não encontrado.");

    const params = pickVariation();
    const stats: VariationStats = { colors: 0, fonts: 0, radii: 0, shadows: 0, spacings: 0, families: {} };
    let contents: Record<string, string> = {};
    for (const s of slugs.data as { slug: string; content: string }[]) {
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
      summary.push(`Copy: ${r.rewritten} ${r.rewritten === 1 ? "trecho reescrito" : "trechos reescritos"} com o novo ângulo.`);
    }

    const name = `${(page.data as { name: string }).name} · variação`.slice(0, 120);
    return { ok: true, contents, summary, name };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Grava no domínio a variação que a tela mostrou (uma página nova, publicada). */
export async function copyTemplateVariation(
  domainId: string,
  templateId: string,
  name: string,
  contents: Record<string, string>,
): Promise<ActionResult<{ pageId: string }>> {
  if (!UUID_RE.test(templateId)) return fail("Escolha um template.");
  const cleanName = (name ?? "").trim().slice(0, 120);
  if (cleanName.length < 2) return fail("Dê um nome à página.");
  for (const html of Object.values(contents ?? {})) {
    if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > MAX_CONTENT_BYTES) return fail("Uma das slugs passa de 5 MB.");
  }
  try {
    const { data, error } = await supabaseService().rpc("domain_page_add", {
      p_domain: domainId,
      p_template: templateId,
      p_name: cleanName,
      p_contents: contents,
    });
    if (error) {
      if (error.code === "P0002") return fail("Template ou domínio não encontrado.");
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    const domain = await domainName(domainId);
    const purged = domain ? await purgeAfterWrite(domain, "Variação copiada") : { ok: true as const };
    return purged.ok ? { ok: true, pageId: String(data) } : purged;
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Troca o conteúdo de uma página do domínio por uma cópia nova de um
 * template. A página continua a mesma (padrão, filtro e rotas seguem nela) e
 * mantém o status; as edições feitas nela se perdem.
 */
export async function replaceDomainPage(domainId: string, pageId: string, templateId: string): Promise<ActionResult> {
  if (!UUID_RE.test(templateId)) return fail("Escolha um template.");
  try {
    const { error } = await supabaseService().rpc("domain_page_replace", { p_domain: domainId, p_page: pageId, p_template: templateId });
    if (error) {
      if (error.code === "P0002") return fail("Página ou template não encontrado.");
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    const domain = await domainName(domainId);
    return domain ? purgeAfterWrite(domain, "Template trocado") : { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Remove uma página do domínio. Recusa enquanto ela é a padrão, a do filtro ou a de alguma rota. */
export async function removeDomainPage(domainId: string, pageId: string): Promise<ActionResult> {
  const db = supabaseService();
  try {
    const [dom, routes] = await Promise.all([
      db.from("domains").select("default_page_id, filter_pass_page_id, filter_fail_page_id").eq("id", domainId).maybeSingle(),
      db.from("domain_routes").select("id", { count: "exact", head: true }).eq("domain_id", domainId).eq("page_id", pageId),
    ]);
    if (dom.error) throw new Error(dom.error.message);
    const d = dom.data as { default_page_id: string | null; filter_pass_page_id: string | null; filter_fail_page_id: string | null } | null;
    if (!d) return fail("Domínio não encontrado.");
    if (d.default_page_id === pageId) return fail("Esta é a página padrão. Escolha outra como padrão antes de remover.");
    if (d.filter_pass_page_id === pageId || d.filter_fail_page_id === pageId) return fail("O filtro do domínio usa esta página. Troque ou limpe o filtro antes.");
    if ((routes.count ?? 0) > 0) return fail(`Há ${routes.count} rota(s) servindo esta página. Ajuste as rotas antes.`);

    const { error } = await db.rpc("domain_page_remove", { p_domain: domainId, p_page: pageId });
    if (error) {
      const own = ownPageError(error);
      if (own) return fail("A página ainda está em uso. Recarregue a tela.");
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Dados do domínio para os marcadores ────────────────────────────────────

export type PlaceholdersFormState = { error?: string; success?: string; attempt: number };

/**
 * Salva os dados que os marcadores {{chave}} usam (pages.domains.placeholders).
 * Grava todos os campos da lista, vazios inclusive: campo vazio vira texto
 * vazio na página, nunca o marcador cru.
 */
export async function savePlaceholders(domainId: string, prev: PlaceholdersFormState, fd: FormData): Promise<PlaceholdersFormState> {
  const attempt = prev.attempt + 1;
  const values: Record<string, string> = {};
  for (const f of PLACEHOLDER_FIELDS) {
    const v = String(fd.get(f.key) ?? "").trim();
    if (v.length > f.max) return { error: `${f.label}: no máximo ${f.max} caracteres.`, attempt };
    values[f.key] = v;
  }
  const email = values["company.email"];
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "E-mail inválido.", attempt };

  try {
    const { data, error } = await supabaseService().from("domains").update({ placeholders: values }).eq("id", domainId).select("domain").single();
    if (error) throw new Error(error.message);
    revalidateDomain(domainId);
    const purged = await purgeAfterWrite((data as { domain: string }).domain, "Dados salvos");
    return purged.ok ? { success: "Dados salvos. As páginas do domínio já usam os valores novos.", attempt } : { error: purged.reason, attempt };
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }
}

/**
 * Liga/desliga o bloqueio de bots do domínio (block_bots). Quando ligado, o
 * match_routes emite um BLOCK 403 no topo que só casa User-Agent de bot; não
 * troca a página servida ao visitante real.
 */
export async function setBotBlock(id: string, value: boolean): Promise<ActionResult> {
  try {
    const { error } = await supabaseService().from("domains").update({ block_bots: value }).eq("id", id);
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

// ── Filtro do domínio ────────────────────────────────────────────────────────

export type FilterFormState = { error?: string; success?: string; attempt: number };

/**
 * Salva o filtro do domínio: as condições, a página de quem passa e a de quem
 * não passa. As condições usam as mesmas dimensões das rotas, MENOS `bot`:
 * detecção de bot serve para bloquear (rotas), nunca para trocar a página.
 * O CHECK ck_domains_filter_no_bot é a garantia no banco.
 */
export async function saveFilter(prev: FilterFormState, fd: FormData): Promise<FilterFormState> {
  const attempt = prev.attempt + 1;
  const domainId = str(fd, "domain_id");
  const passPageId = str(fd, "filter_pass_page_id") || null;
  const failPageId = str(fd, "filter_fail_page_id") || null;

  if (!domainId) return { error: "Domínio ausente.", attempt };
  if (!passPageId) return { error: "Escolha a página para quem PASSA no filtro.", attempt };
  if (!failPageId) return { error: "Escolha a página para quem NÃO passa no filtro.", attempt };

  const conditions = parseConditionsForm(fd);
  if (!conditions.ok) return { error: conditions.reason, attempt };
  if (conditions.value.bot) return { error: 'A condição "só bots" não vale no filtro; use uma rota de bloqueio.', attempt };
  if (Object.keys(conditions.value).length === 0) {
    return { error: "Defina ao menos uma condição, senão todo visitante passa e a página de reprovação nunca aparece.", attempt };
  }

  try {
    const { error } = await supabaseService()
      .from("domains")
      .update({ filter: conditions.value, filter_pass_page_id: passPageId, filter_fail_page_id: failPageId })
      .eq("id", domainId);
    if (error) {
      const own = ownPageError(error);
      if (own) return { error: own, attempt };
      throw new Error(error.message);
    }
    revalidateDomain(domainId);
    return { success: "Filtro salvo. Entra no ar em até 30 s (ou use Limpar cache).", attempt };
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }
}

/** Remove o filtro. O domínio volta a servir só a página padrão / as rotas. */
export async function clearFilter(domainId: string): Promise<ActionResult> {
  try {
    const { error } = await supabaseService()
      .from("domains")
      .update({ filter: null, filter_pass_page_id: null, filter_fail_page_id: null })
      .eq("id", domainId);
    if (error) throw new Error(error.message);
    revalidateDomain(domainId);
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function setDomainStatus(id: string, status: DomainStatus): Promise<ActionResult> {
  if (status !== "ACTIVE" && status !== "PAUSED") return fail("Status inválido.");
  try {
    const { data, error } = await supabaseService().from("domains").update({ status }).eq("id", id).select("domain").single();
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    return purgeAfterWrite(data.domain, status === "ACTIVE" ? "Domínio ativado" : "Domínio pausado");
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function removeDomain(id: string): Promise<ActionResult> {
  try {
    // As rotas caem em cascata (FK ON DELETE CASCADE).
    const { data, error } = await supabaseService().from("domains").delete().eq("id", id).select("domain").single();
    if (error) throw new Error(error.message);
    revalidateDomain(id);
    // Sem aviso se o purge falhar: a tela de detalhe precisa do ok para sair
    // de um registro que não existe mais. No pior caso vale quando o cache vencer.
    await purgeHost(data.domain);
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
      const own = ownPageError(error);
      if (own) return { error: own, attempt };
      // Regex que o JS aceita e o Postgres (POSIX) recusa: o trigger devolve check_violation citando path_pattern.
      if (error.code === "23514" && error.message.includes("path_pattern")) return { error: "Regex inválida para o banco (POSIX).", attempt };
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
