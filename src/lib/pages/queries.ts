import { supabaseService } from "@/lib/supabase/service";
import { scanFunnel, type ScannedVersion } from "./funnel-scan";
import type { Domain, DomainRoute, Folder, FolderScope, Page, PageKind, PageRef, PageSlug, PageSlugSummary, PageStatus } from "./types";

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

/**
 * As colunas de pages.domains menos `site`: site guarda o HTML de todas as
 * páginas do domínio e só é lido slug a slug (domain_slug_get) ou resumido
 * (domain_pages_summary). Nunca `select("*")` em domains.
 */
const DOMAIN_COLUMNS =
  "id,domain,status,default_page_id,filter,filter_pass_page_id,filter_fail_page_id,block_bots,placeholders,settings,notes," +
  "last_checked_at,last_check_ok,last_check_error,created_at,updated_at";

/** Uma slug de página de domínio, sem o HTML. */
export type SiteSlugSummary = {
  slug: string;
  title: string | null;
  is_active: boolean;
  content_type: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
};

type SiteRow = {
  domain_id: string;
  page_id: string;
  name: string;
  kind: PageKind;
  status: PageStatus;
  template_id: string | null;
  created_at: string;
  updated_at: string;
  slugs: SiteSlugSummary[];
};

/** As páginas de domains.site, sem HTML (pages.domain_pages_summary). `null` = todos os domínios. */
async function sitePages(domainIds: string[] | null): Promise<SiteRow[]> {
  const { data, error } = await supabaseService().rpc("domain_pages_summary", { p_domain_ids: domainIds });
  throwIf(error, "domain_pages_summary");
  return (data as SiteRow[] | null) ?? [];
}

const pageRef = (r: SiteRow): PageRef => ({ id: r.page_id, name: r.name, kind: r.kind, status: r.status });

export async function listDomains(): Promise<Domain[]> {
  const { data, error } = await supabaseService().from("domains").select(DOMAIN_COLUMNS).order("domain");
  throwIf(error, "listDomains");
  return (data ?? []) as unknown as Domain[];
}

export type DomainRouteWithPage = DomainRoute & { page: PageRef | null };

export type PageOption = PageRef & { slugs: Pick<PageSlugSummary, "id" | "slug" | "is_active">[] };

/**
 * Uma página do domínio (cópia de template guardada em domains.site). Nas
 * slugs, `id` é o próprio path: dentro da página ele é único.
 */
export type DomainPage = PageOption & {
  template_id: string | null;
  template_name: string | null;
  created_at: string;
  updated_at: string;
};

export type DomainDetail = Domain & {
  default_page: PageRef | null;
  filter_pass_page: PageRef | null;
  filter_fail_page: PageRef | null;
  routes: DomainRouteWithPage[];
  /** As páginas do domínio, na ordem em que foram copiadas. */
  pages: DomainPage[];
};

/** Nome dos templates por id (para "copiada de X"). */
async function templateNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return names;
  const { data, error } = await supabaseService().from("pages").select("id,name").in("id", unique);
  throwIf(error, "templateNames");
  for (const p of (data as { id: string; name: string }[] | null) ?? []) names.set(p.id, p.name);
  return names;
}

async function toDomainPages(rows: SiteRow[]): Promise<DomainPage[]> {
  const names = await templateNames(rows.map((r) => r.template_id).filter((id): id is string => id !== null));
  return rows.map((r) => ({
    ...pageRef(r),
    template_id: r.template_id,
    template_name: r.template_id ? (names.get(r.template_id) ?? null) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    slugs: r.slugs.map((s) => ({ id: s.slug, slug: s.slug, is_active: s.is_active })),
  }));
}

export async function getDomainDetail(id: string): Promise<DomainDetail | null> {
  const [domain, rows] = await Promise.all([
    supabaseService().from("domains").select(`${DOMAIN_COLUMNS}, domain_routes(*)`).eq("id", id).maybeSingle(),
    sitePages([id]),
  ]);
  throwIf(domain.error, "getDomainDetail");
  if (!domain.data) return null;
  const { domain_routes, ...rest } = domain.data as unknown as Domain & { domain_routes: DomainRoute[] };
  const pages = await toDomainPages(rows);
  const ref = (pageId: string | null): PageRef | null => {
    const p = pageId ? pages.find((x) => x.id === pageId) : undefined;
    return p ? { id: p.id, name: p.name, kind: p.kind, status: p.status } : null;
  };
  const routes = [...(domain_routes ?? [])]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => ({ ...r, page: ref(r.page_id) }));
  return {
    ...rest,
    default_page: ref(rest.default_page_id),
    filter_pass_page: ref(rest.filter_pass_page_id),
    filter_fail_page: ref(rest.filter_fail_page_id),
    routes,
    pages,
  };
}

export type PageListItem = Page & {
  slugs_count: number;
  /** Quantos domínios têm uma cópia deste template. */
  copies_count: number;
};

/** Os templates, para a tela /paginas (os funis ficam na tela Funil), com quantas cópias cada um tem nos domínios. */
export async function listPages(): Promise<PageListItem[]> {
  const [templates, copies] = await Promise.all([
    supabaseService().from("pages").select("*, page_slugs(count)").neq("kind", "FUNNEL").order("updated_at", { ascending: false }),
    sitePages(null),
  ]);
  throwIf(templates.error, "listPages");
  const copiesOf = new Map<string, number>();
  for (const c of copies) if (c.template_id) copiesOf.set(c.template_id, (copiesOf.get(c.template_id) ?? 0) + 1);
  return (templates.data ?? []).map((row) => {
    const { page_slugs, ...rest } = row as Page & { page_slugs: CountRow };
    return { ...rest, slugs_count: countOf(page_slugs), copies_count: copiesOf.get(rest.id) ?? 0 };
  });
}

/** As pastas de uma tela (são poucas; a árvore é montada na tela). */
export async function listFolders(scope: FolderScope = "TEMPLATE"): Promise<Folder[]> {
  const { data, error } = await supabaseService().from("folders").select("*").eq("scope", scope).order("name");
  throwIf(error, "listFolders");
  return (data ?? []) as Folder[];
}

// ── Funil: amostras e resultados do teste A/B ────────────────────────────────

/** Um funil do dayone-main (public.funnels, lido por pages.main_funnels). */
export type MainFunnel = { id: string; code: string; name: string; platform: string | null; niche: string | null; region: string | null; status: string | null };

export type FunnelBoardPage = {
  id: string;
  name: string;
  status: PageStatus;
  /** A slug com as etapas (a `/`, ou a primeira) e o id dela, para abrir o editor. */
  slug: string;
  slugId: string | null;
  /** O % (0–100) da página no teste A/B do funil; os do funil somam 100. 0 = pausada. */
  weight: number;
};

/** Uma linha da tela Funil: o funil do dayone-main (null = páginas de funil sem funil) e as páginas dele. */
export type FunnelBoardRow = { funnel: MainFunnel | null; pages: FunnelBoardPage[] };

/**
 * A tela Funil: os funis do dayone-main (F1, F2…) na ordem do código, cada um
 * com as páginas ligadas a ele (pages.funnel_id) e o % de cada uma no teste
 * A/B entre elas. Páginas de funil sem funil (o
 * funil sumiu do dayone-main) vêm numa linha final com `funnel: null`.
 * `stats` é por página da biblioteca, desde `since`: carregamentos reais das
 * cópias nos domínios (views) e quantos clicaram para fora (clicks).
 */
export async function getFunnelBoard(since: Date): Promise<{ rows: FunnelBoardRow[]; stats: Record<string, VersionStats> }> {
  const db = supabaseService();
  const [funnels, pages, stats] = await Promise.all([
    db.rpc("main_funnels"),
    db.from("pages").select("id, name, kind, status, funnel_id, traffic_weight, page_slugs(id, slug)").or("funnel_id.not.is.null,kind.eq.FUNNEL").order("created_at"),
    db.rpc("page_stats", { p_since: since.toISOString() }),
  ]);
  throwIf(funnels.error, "main_funnels");
  throwIf(pages.error, "getFunnelBoard");
  throwIf(stats.error, "page_stats");

  type Row = { id: string; name: string; kind: PageKind; status: PageStatus; funnel_id: string | null; traffic_weight: number; page_slugs: { id: string; slug: string }[] };
  const rows = (pages.data ?? []) as unknown as Row[];
  // A slug de cada página: a `/`, senão a primeira em ordem.
  const root = new Map(rows.map((r) => [r.id, [...r.page_slugs].sort((a, b) => (a.slug === "/" ? -1 : b.slug === "/" ? 1 : a.slug.localeCompare(b.slug)))[0] ?? null]));
  const toPage = (r: Row): FunnelBoardPage => {
    const s = root.get(r.id) ?? null;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      slug: s?.slug ?? "/",
      slugId: s?.id ?? null,
      weight: r.traffic_weight,
    };
  };
  const list = ((funnels.data ?? []) as MainFunnel[]).map((f) => ({ funnel: f, pages: rows.filter((r) => r.funnel_id === f.id).map(toPage) }));
  const known = new Set(list.map((l) => l.funnel.id));
  const orphans = rows.filter((r) => !r.funnel_id || !known.has(r.funnel_id)).map(toPage);

  const byPage: Record<string, VersionStats> = {};
  for (const s of (stats.data as { template_id: string; views: number; clicks: number }[] | null) ?? []) {
    byPage[s.template_id] = { views: Number(s.views), clicks: Number(s.clicks) };
  }
  return { rows: orphans.length ? [...list, { funnel: null, pages: orphans }] : list, stats: byPage };
}

/** Visitantes únicos que viram / clicaram cada amostra (por id da amostra). */
export type VersionStats = { views: number; clicks: number };

/** Resultados por amostra de um domínio (todos os paths somados), desde `since`. */
export async function funnelStatsByStep(domainIds: string[], since: Date): Promise<Map<string, Map<string, VersionStats>>> {
  const out = new Map<string, Map<string, VersionStats>>();
  if (!domainIds.length) return out;
  const { data, error } = await supabaseService().rpc("funnel_stats", { p_domain_ids: domainIds, p_since: since.toISOString() });
  throwIf(error, "funnel_stats");
  for (const r of (data as { domain_id: string; step_id: string; views: number; clicks: number }[] | null) ?? []) {
    const byStep = out.get(r.domain_id) ?? new Map<string, VersionStats>();
    const cur = byStep.get(r.step_id) ?? { views: 0, clicks: 0 };
    byStep.set(r.step_id, { views: cur.views + Number(r.views), clicks: cur.clicks + Number(r.clicks) });
    out.set(r.domain_id, byStep);
  }
  return out;
}

export type FunnelCopy = {
  domain_id: string;
  domain: string;
  page_id: string;
  page_name: string;
  status: PageStatus;
  /** A slug do funil na cópia (a `/`, ou a primeira com etapas) e as amostras dela. */
  slug: string;
  versions: ScannedVersion[];
  stats: Map<string, VersionStats>;
};

export type FunnelDetail = {
  page: PageWithSlugs;
  /** As amostras da slug `/` do funil na biblioteca. */
  versions: ScannedVersion[];
  copies: FunnelCopy[];
};

/** Um funil da biblioteca, as cópias dele nos domínios e o teste A/B de cada cópia desde `since`. */
export async function getFunnelDetail(id: string, since: Date): Promise<FunnelDetail | null> {
  const db = supabaseService();
  const page = await getPageWithSlugs(id);
  if (!page) return null;
  const [root, copies, domains] = await Promise.all([
    db.from("page_slugs").select("content").eq("page_id", id).eq("slug", "/").maybeSingle(),
    sitePages(null),
    db.from("domains").select("id,domain"),
  ]);
  throwIf(root.error, "getFunnelDetail");
  throwIf(domains.error, "getFunnelDetail(domains)");
  const names = new Map(((domains.data ?? []) as { id: string; domain: string }[]).map((d) => [d.id, d.domain]));
  const mine = copies.filter((c) => c.template_id === id);
  const stats = await funnelStatsByStep([...new Set(mine.map((c) => c.domain_id))], since);

  const out: FunnelCopy[] = [];
  for (const c of mine) {
    // A slug com etapas: a `/` se tiver, senão a primeira que tiver.
    const order = [...c.slugs].sort((a, b) => (a.slug === "/" ? -1 : b.slug === "/" ? 1 : a.slug.localeCompare(b.slug)));
    let found: { slug: string; versions: ScannedVersion[] } | null = null;
    for (const s of order) {
      const got = await db.rpc("domain_slug_get", { p_domain: c.domain_id, p_page: c.page_id, p_slug: s.slug });
      throwIf(got.error, "domain_slug_get");
      const versions = scanFunnel((got.data as { content: string }[] | null)?.[0]?.content ?? "");
      if (versions.length) {
        found = { slug: s.slug, versions };
        break;
      }
    }
    out.push({
      domain_id: c.domain_id,
      domain: names.get(c.domain_id) ?? c.domain_id,
      page_id: c.page_id,
      page_name: c.name,
      status: c.status,
      slug: found?.slug ?? "/",
      versions: found?.versions ?? [],
      stats: stats.get(c.domain_id) ?? new Map(),
    });
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain));
  return { page, versions: scanFunnel((root.data as { content: string } | null)?.content ?? ""), copies: out };
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

export type TemplateOption = PageRef & { slugs_count: number };

/** Templates para copiar para um domínio (os arquivados ficam de fora). */
export async function listTemplates(): Promise<TemplateOption[]> {
  const { data, error } = await supabaseService()
    .from("pages")
    .select("id,name,kind,status, page_slugs(count)")
    .neq("status", "ARCHIVED")
    .order("name");
  throwIf(error, "listTemplates");
  return (data ?? []).map((row) => {
    const { page_slugs, ...rest } = row as PageRef & { page_slugs: CountRow };
    return { ...rest, slugs_count: countOf(page_slugs) };
  });
}

export type DomainPageEditorData = {
  domain: Pick<Domain, "id" | "domain" | "placeholders">;
  /** A página no formato do editor (os campos de template que não existem aqui vêm vazios). */
  page: Page;
  /** As slugs; `id` = path. */
  slugs: PageSlugSummary[];
  slug: PageSlug;
};

/**
 * Uma página de domains.site aberta no editor, na slug pedida (ou na raiz,
 * ou na primeira). null se o domínio, a página ou a slug não existem.
 */
export async function getDomainPageForEditor(domainId: string, pageId: string, slugPath: string | null): Promise<DomainPageEditorData | null> {
  const db = supabaseService();
  const [domain, rows] = await Promise.all([
    db.from("domains").select("id,domain,placeholders").eq("id", domainId).maybeSingle(),
    sitePages([domainId]),
  ]);
  throwIf(domain.error, "getDomainPageForEditor");
  const row = rows.find((r) => r.page_id === pageId);
  if (!domain.data || !row) return null;

  const slugs: PageSlugSummary[] = row.slugs.map((s) => ({
    id: s.slug,
    page_id: row.page_id,
    slug: s.slug,
    title: s.title,
    content_type: s.content_type,
    content_hash: s.content_hash,
    is_active: s.is_active,
    published_at: null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));
  const current = (slugPath ? slugs.find((s) => s.slug === slugPath) : undefined) ?? (slugPath ? undefined : (slugs.find((s) => s.slug === "/") ?? slugs[0]));
  if (!current) return null;

  const got = await db.rpc("domain_slug_get", { p_domain: domainId, p_page: pageId, p_slug: current.slug });
  throwIf(got.error, "domain_slug_get");
  const content = (got.data as { content: string }[] | null)?.[0]?.content;
  if (content === undefined) return null;

  return {
    domain: domain.data as DomainPageEditorData["domain"],
    page: { id: row.page_id, name: row.name, kind: row.kind, status: row.status, notes: null, folder_id: null, funnel_id: null, created_at: row.created_at, updated_at: row.updated_at },
    slugs,
    slug: { ...current, content },
  };
}

export type Overview = {
  domains: number;
  domainsActive: number;
  /** Templates. */
  pages: number;
  /** Páginas copiadas para os domínios (domains.site). */
  domainPages: number;
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

/** Filtros das leituras do dashboard. Lista vazia = sem filtro. */
export type HitFilter = {
  domainId?: string | null;
  outcomes?: string[];
  devices?: string[];
  countries?: string[];
  hideBots?: boolean;
};

function filterArgs(f: HitFilter) {
  return {
    p_domain: f.domainId ?? null,
    p_outcomes: f.outcomes?.length ? f.outcomes : null,
    p_devices: f.devices?.length ? f.devices : null,
    p_countries: f.countries?.length ? f.countries : null,
    p_hide_bots: f.hideBots ?? false,
  };
}

/** Contadores do período (para os cards). */
export async function hitStats(since: Date, filter: HitFilter = {}): Promise<HitStats> {
  const { data, error } = await supabaseService().rpc("hit_stats", { p_since: since.toISOString(), ...filterArgs(filter) });
  throwIf(error, "hitStats");
  const r = (data as Record<string, unknown>[] | null)?.[0];
  return { total: n(r?.total), served: n(r?.served), blocked: n(r?.blocked), bots: n(r?.bots), uniques: n(r?.uniques) };
}

/** Série por bucket (para o gráfico), já sem buracos. `origin` alinha os buckets (ex.: meia-noite local). */
export async function hitTimeseries(since: Date, bucketMinutes: number, origin: Date | null = null, filter: HitFilter = {}): Promise<HitBucket[]> {
  const { data, error } = await supabaseService().rpc("hit_timeseries", {
    p_since: since.toISOString(),
    p_bucket: `${bucketMinutes} minutes`,
    p_origin: origin?.toISOString() ?? null,
    ...filterArgs(filter),
  });
  throwIf(error, "hitTimeseries");
  return (data as Record<string, unknown>[] | null ?? []).map((r) => ({
    bucket: String(r.bucket),
    served: n(r.served),
    blocked: n(r.blocked),
    bots: n(r.bots),
  }));
}

/** Últimos N hits (para os Access Logs), desde `since` quando dado. */
export async function recentHits(limit = 20, since: Date | null = null, filter: HitFilter = {}): Promise<HitRow[]> {
  const { data, error } = await supabaseService().rpc("recent_hits", {
    p_limit: limit,
    p_since: since?.toISOString() ?? null,
    ...filterArgs(filter),
  });
  throwIf(error, "recentHits");
  return (data as HitRow[] | null) ?? [];
}

/** Países com hit no período (para o filtro de país), do mais frequente ao menos. */
export async function hitCountries(since: Date, domainId: string | null = null): Promise<{ country: string; hits: number }[]> {
  const { data, error } = await supabaseService().rpc("hit_countries", { p_since: since.toISOString(), p_domain: domainId });
  throwIf(error, "hitCountries");
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({ country: String(r.country), hits: n(r.hits) }));
}

export type UnregisteredHost = { domain: string; hits: number; bots: number; last_seen: string };

/**
 * Hosts que chegaram ao servidor (pages.hits) e não estão cadastrados, já
 * normalizados como pages.domains (sem www.), do visto mais recente ao mais
 * antigo. `since` null = todo o histórico. Regras em pages.unregistered_hosts.
 */
export async function unregisteredHosts(since: Date | null = null): Promise<UnregisteredHost[]> {
  const { data, error } = await supabaseService().rpc("unregistered_hosts", { p_since: since?.toISOString() ?? null });
  throwIf(error, "unregisteredHosts");
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
    domain: String(r.domain),
    hits: n(r.hits),
    bots: n(r.bots),
    last_seen: String(r.last_seen),
  }));
}

/** Um hit com tudo o que pages.hits guarda (para a tela de Logs). */
export type HitLogRow = HitRow & {
  id: number;
  domain_id: string | null;
  user_agent: string | null;
  hostname: string | null;
  asn: number | null;
  as_name: string | null;
  cookies: string | null;
  region: string | null;
  route_id: string | null;
  page_id: string | null;
  slug: string | null;
  decision: string | null;
  /** Query string crua, sem o "?". */
  query: string | null;
  /** Location devolvido quando o hit foi redirect (a URL final). */
  redirect_url: string | null;
  /** Id da visita (cookie dop_v) quando a resposta foi página HTML com o aviso de carregamento. */
  visit_id: string | null;
  /** Domínio cadastrado (pages.domains), não o host da request. */
  domain: string | null;
  page_name: string | null;
  /** Aviso do navegador de que a página carregou (pages.hit_loads); null se não veio. */
  load: { loaded_at: string; load_ms: number | null } | null;
};

/**
 * Página de hits, do mais novo para o mais antigo. Paginação por cursor:
 * `beforeId` = id do último da página anterior (o índice por created_at segue
 * a mesma ordem do id, que é IDENTITY). Pede um a mais para saber se há próxima.
 */
export async function listHits(opts: { domainId?: string | null; beforeId?: number | null; limit?: number } = {}): Promise<{ rows: HitLogRow[]; hasMore: boolean }> {
  const limit = opts.limit ?? 100;
  const db = supabaseService();
  let q = db
    .from("hits")
    .select(
      "id, created_at, domain_id, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip, user_agent, " +
        "hostname, asn, as_name, cookies, region, route_id, page_id, slug, decision, query, redirect_url, visit_id, domains(domain)",
    )
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (opts.domainId) q = q.eq("domain_id", opts.domainId);
  if (opts.beforeId) q = q.lt("id", opts.beforeId);
  const { data, error } = await q;
  throwIf(error, "listHits");

  type Raw = Omit<HitLogRow, "domain" | "page_name" | "load"> & { domains: { domain: string } | null };
  const raw = (data as unknown as Raw[] | null) ?? [];
  const rows = raw.slice(0, limit);

  // page_id não tem FK (a página pode ter sido apagada), então o nome vem numa segunda leitura: das
  // páginas dos domínios (domains.site) e, para hits antigos que apontam para um template, de pages.
  const pageIds = [...new Set(rows.map((r) => r.page_id).filter((id): id is string => id !== null))];
  const pageNames = new Map<string, string>();
  if (pageIds.length > 0) {
    const domainIds = [...new Set(rows.map((r) => r.domain_id).filter((id): id is string => id !== null))];
    const [site, templates] = await Promise.all([
      domainIds.length > 0 ? sitePages(domainIds) : Promise.resolve([]),
      db.from("pages").select("id, name").in("id", pageIds),
    ]);
    throwIf(templates.error, "listHits (páginas)");
    for (const p of (templates.data as Pick<Page, "id" | "name">[] | null) ?? []) pageNames.set(p.id, p.name);
    for (const p of site) pageNames.set(p.page_id, p.name);
  }

  // O aviso de carregamento fica em outra tabela (chega antes do hit, sem FK): terceira leitura.
  const visitIds = rows.map((r) => r.visit_id).filter((id): id is string => id !== null);
  const loads = new Map<string, { loaded_at: string; load_ms: number | null }>();
  if (visitIds.length > 0) {
    const { data: loaded, error: loadsError } = await db.from("hit_loads").select("visit_id, loaded_at, load_ms").in("visit_id", visitIds);
    throwIf(loadsError, "listHits (carregamentos)");
    for (const l of (loaded as { visit_id: string; loaded_at: string; load_ms: number | null }[] | null) ?? []) {
      loads.set(l.visit_id, { loaded_at: l.loaded_at, load_ms: l.load_ms });
    }
  }

  return {
    rows: rows.map(({ domains, ...r }) => ({
      ...r,
      domain: domains?.domain ?? null,
      page_name: r.page_id ? (pageNames.get(r.page_id) ?? null) : null,
      load: r.visit_id ? (loads.get(r.visit_id) ?? null) : null,
    })),
    hasMore: raw.length > limit,
  };
}

export async function countOverview(): Promise<Overview> {
  const db = supabaseService();
  const head = { count: "exact" as const, head: true };
  const [d, da, p, site, r] = await Promise.all([
    db.from("domains").select("id", head),
    db.from("domains").select("id", head).eq("status", "ACTIVE"),
    db.from("pages").select("id", head),
    sitePages(null),
    db.from("domain_routes").select("id", head),
  ]);
  return {
    domains: d.count ?? 0,
    domainsActive: da.count ?? 0,
    pages: p.count ?? 0,
    domainPages: site.length,
    routes: r.count ?? 0,
  };
}

// ── Regras de Detecção (bots e suspeitos) ────────────────────────────────────

