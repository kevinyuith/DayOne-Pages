"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { purgeHost } from "@/lib/origin/purge";
import { loadFunnelWeights, writeFunnelWeights } from "@/lib/pages/funnel-weights";
import { evenSplit, setShare } from "@/lib/pages/traffic";
import { supabaseService } from "@/lib/supabase/service";

/**
 * Ações da tela Funil: o teste A/B entre as páginas de um funil.
 *
 * O % de cada página (`pages.traffic_weight`, sempre somando 100 no funil —
 * ver traffic.ts) é lido ao vivo pelo pages.resolve para as cópias nos
 * domínios, então mudar um % vale para todos os domínios que têm o funil — o
 * cache do servidor desses domínios é purgado para valer na hora (sem o
 * purge, vale em até 30 s).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Os domínios que têm cópia de alguma página destes templates (para purgar o cache deles). */
async function domainsWithCopies(templateIds: string[]): Promise<string[]> {
  if (!templateIds.length) return [];
  const { data, error } = await supabaseService().rpc("domain_pages_summary", { p_domain_ids: null });
  if (error) throw new Error(error.message);
  const ids = new Set(((data ?? []) as { domain_id: string; template_id: string | null }[]).filter((r) => r.template_id && templateIds.includes(r.template_id)).map((r) => r.domain_id));
  if (!ids.size) return [];
  const got = await supabaseService().from("domains").select("domain").in("id", [...ids]);
  if (got.error) throw new Error(got.error.message);
  return ((got.data ?? []) as { domain: string }[]).map((d) => d.domain);
}

async function purgeAll(domains: string[]): Promise<ActionResult> {
  const failed: string[] = [];
  for (const d of domains) {
    const r = await purgeHost(d);
    if (!r.ok && !r.skipped) failed.push(d);
  }
  return failed.length ? fail(`Saved, but the server cache of ${failed.join(", ")} wasn't cleared. It takes effect within 30 s.`) : { ok: true };
}

/** As páginas de um funil do dayone-main (id em public.funnels). */
async function funnelPages(funnelId: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabaseService().from("pages").select("id, name").eq("funnel_id", funnelId).neq("status", "ARCHIVED").order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; name: string }[];
}

/** O % (0–100) de uma página no teste A/B do funil; as outras dividem o resto na proporção que tinham. 0 pausa. */
export async function setPageShare(pageId: string, share: number): Promise<ActionResult> {
  if (!UUID_RE.test(pageId)) return fail("Invalid page.");
  if (!Number.isInteger(share) || share < 0 || share > 100) return fail("The traffic goes from 0 to 100%.");
  try {
    const { data, error } = await supabaseService().from("pages").select("funnel_id").eq("id", pageId).maybeSingle();
    if (error) throw new Error(error.message);
    const funnelId = (data as { funnel_id: string | null } | null)?.funnel_id;
    if (!funnelId) return fail("Page not found.");
    const current = await loadFunnelWeights(funnelId);
    await writeFunnelWeights(current, setShare(current, pageId, share));
    revalidatePath("/funil");
    return purgeAll(await domainsWithCopies(Object.keys(current)));
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Partes iguais entre as páginas do funil (50/50, 34/33/33…). */
export async function splitFunnelEvenly(funnelId: string): Promise<ActionResult> {
  if (!UUID_RE.test(funnelId)) return fail("Invalid funnel.");
  try {
    const current = await loadFunnelWeights(funnelId);
    await writeFunnelWeights(current, evenSplit(Object.keys(current)));
    revalidatePath("/funil");
    return purgeAll(await domainsWithCopies(Object.keys(current)));
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/**
 * Copia o funil inteiro para o domínio: uma cópia de cada página (as que não
 * estão arquivadas). No domínio, as cópias de um mesmo funil disputam o
 * tráfego da mesma URL pelos pesos (pages.resolve + split_pick). Um domínio
 * sem página padrão fica com a primeira.
 */
export async function copyFunnelToDomain(domainId: string, funnelId: string): Promise<ActionResult<{ copied: number }>> {
  if (!UUID_RE.test(domainId) || !UUID_RE.test(funnelId)) return fail("Choose a domain.");
  try {
    const pages = await funnelPages(funnelId);
    if (!pages.length) return fail("This funnel has no pages yet.");
    const db = supabaseService();
    for (const p of pages) {
      const { error } = await db.rpc("domain_page_copy", { p_domain: domainId, p_template: p.id });
      if (error) {
        if (error.code === "P0002") return fail("Domain not found.");
        throw new Error(error.message);
      }
    }
    const got = await db.from("domains").select("domain").eq("id", domainId).maybeSingle();
    if (got.error) throw new Error(got.error.message);
    revalidatePath("/funil");
    revalidatePath("/dominios", "layout");
    const domain = (got.data as { domain: string } | null)?.domain;
    const purged = domain ? await purgeAll([domain]) : { ok: true as const };
    return purged.ok ? { ok: true, copied: pages.length } : purged;
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
