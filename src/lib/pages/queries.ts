import { supabaseService } from "@/lib/supabase/service";
import type { Domain, DomainRoute, Page, PageRef, PageSlug, PageSlugSummary } from "./types";

/**
 * Leituras do schema `pages`, para Server Components.
 *
 * Tudo passa pelo client de serviço. O painel não tem login: quem o
 * protege é a rede (Cloudflare Access, allowlist de IP) na frente do deploy.
 *
 * Erro do banco aqui LANÇA: uma tela de lista sem dados não tem o que
 * mostrar de útil, e o error boundary do Next exibe a falha.
 */

function throwIf(error: { message: string } | null, where: string) {
  if (error) throw new Error(`${where}: ${error.message}`);
}

type CountRow = { count: number }[];
function countOf(rows: CountRow | null | undefined): number {
  return rows?.[0]?.count ?? 0;
}

export type DomainListItem = Domain & {
  default_page: PageRef | null;
  routes_count: number;
};

export async function listDomains(): Promise<DomainListItem[]> {
  const { data, error } = await supabaseService()
    .from("domains")
    // domains tem 3 FKs para pages (default, filter_pass, filter_fail); nomear a FK desfaz a ambiguidade.
    .select("*, default_page:pages!domains_default_page_id_fkey(id,name,kind,status), domain_routes(count)")
    .order("domain");
  throwIf(error, "listDomains");
  return (data ?? []).map((row) => {
    const { domain_routes, ...rest } = row as Domain & { default_page: PageRef | null; domain_routes: CountRow };
    return { ...rest, routes_count: countOf(domain_routes) };
  });
}

export type DomainRouteWithPage = DomainRoute & { page: PageRef | null };

export type DomainDetail = Domain & {
  default_page: PageRef | null;
  filter_pass_page: PageRef | null;
  filter_fail_page: PageRef | null;
  routes: DomainRouteWithPage[];
};

export async function getDomainDetail(id: string): Promise<DomainDetail | null> {
  const { data, error } = await supabaseService()
    .from("domains")
    .select(
      "*, default_page:pages!domains_default_page_id_fkey(id,name,kind,status)," +
        "filter_pass_page:pages!domains_filter_pass_page_id_fkey(id,name,kind,status)," +
        "filter_fail_page:pages!domains_filter_fail_page_id_fkey(id,name,kind,status)," +
        "domain_routes(*, page:pages(id,name,kind,status))",
    )
    .eq("id", id)
    .maybeSingle();
  throwIf(error, "getDomainDetail");
  if (!data) return null;
  const { domain_routes, ...rest } = data as unknown as DomainDetail & { domain_routes: DomainRouteWithPage[] };
  const routes = [...(domain_routes ?? [])].sort((a, b) => a.priority - b.priority);
  return { ...rest, routes };
}

export type PageListItem = Page & {
  slugs_count: number;
  domains_count: number;
  routes_count: number;
};

export async function listPages(): Promise<PageListItem[]> {
  const { data, error } = await supabaseService()
    .from("pages")
    // domains referencia pages por 3 FKs; nomeamos a de página padrão para o count não ficar ambíguo.
    .select("*, page_slugs(count), domains!domains_default_page_id_fkey(count), domain_routes(count)")
    .order("updated_at", { ascending: false });
  throwIf(error, "listPages");
  return (data ?? []).map((row) => {
    const { page_slugs, domains, domain_routes, ...rest } = row as Page & {
      page_slugs: CountRow;
      domains: CountRow;
      domain_routes: CountRow;
    };
    return {
      ...rest,
      slugs_count: countOf(page_slugs),
      domains_count: countOf(domains),
      routes_count: countOf(domain_routes),
    };
  });
}

export type PageWithSlugs = Page & { slugs: PageSlugSummary[] };

export async function getPageWithSlugs(id: string): Promise<PageWithSlugs | null> {
  const { data, error } = await supabaseService()
    .from("pages")
    .select("*, page_slugs(id,page_id,slug,title,content_type,content_hash,is_active,published_at,created_at,updated_at)")
    .eq("id", id)
    .maybeSingle();
  throwIf(error, "getPageWithSlugs");
  if (!data) return null;
  const { page_slugs, ...rest } = data as Page & { page_slugs: PageSlugSummary[] };
  const slugs = [...(page_slugs ?? [])].sort((a, b) => (a.slug === "/" ? -1 : b.slug === "/" ? 1 : a.slug.localeCompare(b.slug)));
  return { ...rest, slugs };
}

export async function getSlug(slugId: string): Promise<PageSlug | null> {
  const { data, error } = await supabaseService().from("page_slugs").select("*").eq("id", slugId).maybeSingle();
  throwIf(error, "getSlug");
  return (data as PageSlug | null) ?? null;
}

export type PageOption = PageRef & { slugs: Pick<PageSlugSummary, "id" | "slug" | "is_active">[] };

/** Páginas para os selects (página padrão do domínio, rota). Todas, com status, para a tela avisar. */
export async function listPageOptions(): Promise<PageOption[]> {
  const { data, error } = await supabaseService()
    .from("pages")
    .select("id,name,kind,status, page_slugs(id,slug,is_active)")
    .neq("status", "ARCHIVED")
    .order("name");
  throwIf(error, "listPageOptions");
  return (data ?? []).map((row) => {
    const { page_slugs, ...rest } = row as PageRef & { page_slugs: PageOption["slugs"] };
    return { ...rest, slugs: [...(page_slugs ?? [])].sort((a, b) => a.slug.localeCompare(b.slug)) };
  });
}

/** Domínios que usam a página (como padrão ou por rota). Para a base do preview. */
export async function domainsUsingPage(pageId: string): Promise<string[]> {
  const db = supabaseService();
  const [byDefault, byRoute] = await Promise.all([
    db.from("domains").select("domain").eq("default_page_id", pageId),
    db.from("domain_routes").select("domains(domain)").eq("page_id", pageId),
  ]);
  throwIf(byDefault.error, "domainsUsingPage");
  throwIf(byRoute.error, "domainsUsingPage");
  const set = new Set<string>();
  for (const r of byDefault.data ?? []) set.add((r as { domain: string }).domain);
  for (const r of byRoute.data ?? []) {
    // Embed many-to-one vem como objeto; sem tipos gerados o client não sabe disso.
    const d = (r as unknown as { domains: { domain: string } | { domain: string }[] | null }).domains;
    for (const item of Array.isArray(d) ? d : d ? [d] : []) set.add(item.domain);
  }
  return Array.from(set).sort();
}

export type Overview = {
  domains: number;
  domainsActive: number;
  pages: number;
  pagesPublished: number;
  routes: number;
};

// ── Tráfego (hits) ───────────────────────────────────────────────────────────

export type HitStats = { total: number; served: number; blocked: number; bots: number; uniques: number };
export type HitBucket = { bucket: string; served: number; blocked: number; bots: number };
export type HitRow = {
  created_at: string;
  host: string;
  path: string;
  outcome: string;
  status_code: number | null;
  country: string | null;
  device: string | null;
  is_bot: boolean;
  referrer_host: string | null;
  ip: string | null;
};

const n = (v: unknown) => Number(v ?? 0);

/** Contadores do período (para os cards). */
export async function hitStats(since: Date, domainId: string | null = null): Promise<HitStats> {
  const { data, error } = await supabaseService().rpc("hit_stats", { p_since: since.toISOString(), p_domain: domainId });
  throwIf(error, "hitStats");
  const r = (data as Record<string, unknown>[] | null)?.[0];
  return { total: n(r?.total), served: n(r?.served), blocked: n(r?.blocked), bots: n(r?.bots), uniques: n(r?.uniques) };
}

/** Série por bucket (para o gráfico), já sem buracos. */
export async function hitTimeseries(since: Date, bucketMinutes: number, domainId: string | null = null): Promise<HitBucket[]> {
  const { data, error } = await supabaseService().rpc("hit_timeseries", {
    p_since: since.toISOString(),
    p_bucket: `${bucketMinutes} minutes`,
    p_domain: domainId,
  });
  throwIf(error, "hitTimeseries");
  return (data as Record<string, unknown>[] | null ?? []).map((r) => ({
    bucket: String(r.bucket),
    served: n(r.served),
    blocked: n(r.blocked),
    bots: n(r.bots),
  }));
}

/** Últimos N hits (para os Access Logs). */
export async function recentHits(limit = 20, domainId: string | null = null): Promise<HitRow[]> {
  const { data, error } = await supabaseService().rpc("recent_hits", { p_limit: limit, p_domain: domainId });
  throwIf(error, "recentHits");
  return (data as HitRow[] | null) ?? [];
}

export async function countOverview(): Promise<Overview> {
  const db = supabaseService();
  const head = { count: "exact" as const, head: true };
  const [d, da, p, pp, r] = await Promise.all([
    db.from("domains").select("id", head),
    db.from("domains").select("id", head).eq("status", "ACTIVE"),
    db.from("pages").select("id", head),
    db.from("pages").select("id", head).eq("status", "PUBLISHED"),
    db.from("domain_routes").select("id", head),
  ]);
  return {
    domains: d.count ?? 0,
    domainsActive: da.count ?? 0,
    pages: p.count ?? 0,
    pagesPublished: pp.count ?? 0,
    routes: r.count ?? 0,
  };
}
