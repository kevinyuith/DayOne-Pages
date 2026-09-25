import { supabaseService } from "@/lib/supabase/service";
import { scanFunnel, type ScannedVersion } from "./funnel-scan";
import type { Domain, Page, PageKind, PageRef, PageSlug, PageSlugSummary, PageStatus } from "./types";

/**
 * Reads from the `pages` schema, for Server Components.
 *
 * Everything goes through the service client. The dashboard has no login: what
 * protects it is the network (Cloudflare Access, IP allowlist) in front of the deploy.
 *
 * A database error here THROWS: a list screen with no data has nothing
 * useful to show, and Next's error boundary displays the failure.
 */

function throwIf(error: { message: string } | null, where: string) {
  if (error) throw new Error(`${where}: ${error.message}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The columns of pages.domains minus `site`: site holds the HTML of every
 * page of the domain and is only read slug by slug (domain_slug_get) or summarized
 * (domain_pages_summary). Never `select("*")` on domains.
 */
const DOMAIN_COLUMNS =
  "id,domain,type,status,gate_slugs,placeholders,settings,notes," +
  "last_checked_at,last_check_ok,last_check_error,created_at,updated_at";

/** A domain page's slug, without the HTML. */
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
  /** Copy of a funnel page (pages.funnels): its id there. */
  funnel_page_id: string | null;
  created_at: string;
  updated_at: string;
  slugs: SiteSlugSummary[];
};

/** The pages in domains.site, without HTML (pages.domain_pages_summary). `null` = every domain. */
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

export type PageOption = PageRef & { slugs: Pick<PageSlugSummary, "id" | "slug" | "is_active">[] };

/**
 * A domain's page (a template copy stored in domains.site). In the slugs,
 * `id` is the path itself: it's unique within the page.
 */
export type DomainPage = PageOption & {
  template_id: string | null;
  template_name: string | null;
  created_at: string;
  updated_at: string;
};

export type DomainDetail = Domain & {
  /** The domain's pages, in the order they were copied. */
  pages: DomainPage[];
};

/** Template names by id (for "copied from X"). */
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
    supabaseService().from("domains").select(DOMAIN_COLUMNS).eq("id", id).maybeSingle(),
    sitePages([id]),
  ]);
  throwIf(domain.error, "getDomainDetail");
  if (!domain.data) return null;
  const rest = domain.data as unknown as Domain;
  const pages = await toDomainPages(rows);
  return { ...rest, gate_slugs: (rest.gate_slugs as string[] | null) ?? [], pages };
}

export type PageListItem = Page & {
  slugs_count: number;
  /** How many domains have a copy of this template. */
  copies_count: number;
};

/** A page from pages.pages without the HTML (pages.pages_summary). */
type PageSummaryRow = {
  id: string;
  scope: "TEMPLATE" | "DOMAIN" | "FUNNEL";
  name: string;
  kind: PageKind;
  status: PageStatus;
  notes: string | null;
  folder: string | null;
  template_id: string | null;
  funnel_id: string | null;
  funnel_page_id: string | null;
  created_at: string;
  updated_at: string;
  slugs: SiteSlugSummary[];
};

/** Pages without the HTML (the `slugs` column of pages.pages carries the HTML: never `select("*")` on it). */
async function pagesSummary(ids: string[] | null, scope: PageSummaryRow["scope"] | null): Promise<PageSummaryRow[]> {
  const { data, error } = await supabaseService().rpc("pages_summary", { p_ids: ids, p_scope: scope });
  throwIf(error, "pages_summary");
  return (data as PageSummaryRow[] | null) ?? [];
}

const asPage = (r: PageSummaryRow): Page => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  status: r.status,
  notes: r.notes,
  folder: r.folder,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** The templates, for the /templates screen, with how many copies each one has on the domains. */
export async function listPages(): Promise<PageListItem[]> {
  const [templates, copies] = await Promise.all([pagesSummary(null, "TEMPLATE"), pagesSummary(null, "DOMAIN")]);
  const copiesOf = new Map<string, number>();
  for (const c of copies) if (c.template_id) copiesOf.set(c.template_id, (copiesOf.get(c.template_id) ?? 0) + 1);
  return templates.map((r) => ({ ...asPage(r), slugs_count: r.slugs.length, copies_count: copiesOf.get(r.id) ?? 0 }));
}

// ── Funnel: variants and A/B test results ────────────────────────────────────

/** A dayone-main funnel (public.funnels, read via pages.main_funnels). */
export type MainFunnel = { id: string; code: string; name: string; platform: string | null; niche: string | null; region: string | null; status: string | null };

/** A funnel page, without the HTML (pages.funnel_pages_summary). */
type FunnelPageRow = {
  funnel_id: string;
  main_funnel_id: string | null;
  page_id: string;
  name: string;
  status: PageStatus;
  weight: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  slugs: SiteSlugSummary[];
};

async function funnelPages(funnelIds: string[] | null): Promise<FunnelPageRow[]> {
  const { data, error } = await supabaseService().rpc("funnel_pages_summary", { p_funnel_ids: funnelIds });
  throwIf(error, "funnel_pages_summary");
  return (data as FunnelPageRow[] | null) ?? [];
}

/** A page's main slug: `/`, otherwise the first in order. */
const rootSlug = (slugs: { slug: string }[]) => [...slugs].sort((a, b) => (a.slug === "/" ? -1 : b.slug === "/" ? 1 : a.slug.localeCompare(b.slug)))[0]?.slug ?? "/";

export type FunnelBoardPage = {
  id: string;
  /** The pages.funnels row that holds the page. */
  funnelId: string;
  name: string;
  status: PageStatus;
  /** The page's % (0–100) in the funnel's A/B test; a funnel's pages add up to 100. 0 = paused. */
  weight: number;
};

/** A row of the Funnel screen: the dayone-main funnel (null = funnel pages with no funnel) and its pages. */
export type FunnelBoardRow = { funnel: MainFunnel | null; pages: FunnelBoardPage[] };

/**
 * The Funnel screen: the dayone-main funnels (F1, F2…) in code order, each
 * with its pages (pages.funnels) and each page's % in the A/B test among
 * them. Pages whose funnel disappeared from dayone-main come in a final row
 * with `funnel: null`. `stats` is per funnel page, since `since`: real loads
 * of the copies on the domains (views) and how many clicked out (clicks).
 */
export async function getFunnelBoard(since: Date): Promise<{ rows: FunnelBoardRow[]; stats: Record<string, VersionStats> }> {
  const db = supabaseService();
  // Every dayone-main funnel gets its pages.funnels row, with its current code and name.
  const synced = await db.rpc("funnels_sync");
  throwIf(synced.error, "funnels_sync");
  const [funnels, pages, stats] = await Promise.all([db.rpc("main_funnels"), funnelPages(null), db.rpc("funnel_page_stats", { p_since: since.toISOString() })]);
  throwIf(funnels.error, "main_funnels");
  throwIf(stats.error, "funnel_page_stats");

  const toPage = (r: FunnelPageRow): FunnelBoardPage => ({ id: r.page_id, funnelId: r.funnel_id, name: r.name, status: r.status, weight: r.weight });
  const list = ((funnels.data ?? []) as MainFunnel[]).map((f) => ({ funnel: f, pages: pages.filter((r) => r.main_funnel_id === f.id).map(toPage) }));
  const known = new Set(list.map((l) => l.funnel.id));
  const orphans = pages.filter((r) => !r.main_funnel_id || !known.has(r.main_funnel_id)).map(toPage);

  const byPage: Record<string, VersionStats> = {};
  for (const s of (stats.data as { funnel_page_id: string; views: number; clicks: number }[] | null) ?? []) {
    byPage[s.funnel_page_id] = { views: Number(s.views), clicks: Number(s.clicks) };
  }
  return { rows: orphans.length ? [...list, { funnel: null, pages: orphans }] : list, stats: byPage };
}

/** A funnel page's real loads (views) and how many clicked out (clicks). */
export type VersionStats = { views: number; clicks: number };

// ── Funnel screen, VSLs tab ──────────────────────────────────────────────────

/** A VSL's status in its funnels (public.vsl.funnel_status). */
export const VSL_STATUSES = ["VALIDATED", "VALIDATION", "STAND_BY", "PAUSED", "DISCARDED"] as const;
export type VslStatus = (typeof VSL_STATUSES)[number];

/** A dayone-main VSL (read-only). */
export type FunnelVsl = {
  id: string;
  title: string;
  status: VslStatus | null;
  language: string | null;
  /** Seconds into the video where the pitch starts. */
  pitch: number | null;
  copywriter: string | null;
  editor: string | null;
  videoUrl: string | null;
};

/** A video (VTurb player) of the funnel's A/B test, with its share and, when found, its VSL. */
export type FunnelVideo = { id: string; name: string | null; weight: number; vsl: FunnelVsl | null };

/** A funnel's VSLs tab: its VSL split (pages.funnels.vsl). */
export type FunnelVslPanel = {
  /** The pages.funnels row. */
  funnelRowId: string;
  /** The split's version (vsl_updated_at): a save goes only over this one. */
  version: string | null;
  /** The split's videos, most traffic first. */
  videos: FunnelVideo[];
};

type RawVsl = { title: string | null; funnel_status: string | null; language: string | null; pitch: number | null; copywriter: string | null; editor: string | null; video_url: string | null };
const toVsl = (id: string, v: RawVsl): FunnelVsl => ({
  id,
  title: v.title?.trim() || "Untitled",
  status: (VSL_STATUSES as readonly string[]).includes(v.funnel_status ?? "") ? (v.funnel_status as VslStatus) : null,
  language: v.language,
  pitch: v.pitch,
  copywriter: v.copywriter,
  editor: v.editor,
  videoUrl: v.video_url,
});
/** A video's name as a VSL title: without the ".mp4" of the uploaded file. */
const titleKey = (s: string | null) => (s ?? "").replace(/\.mp4$/i, "").trim().toLowerCase();

/** A produced VSL (dayone-main) and its VTurb video, to add it to a funnel's test. */
export type ProducedVsl = FunnelVsl & { videoId: string | null };

/**
 * The finished VSLs (dayone-main, not archived) a funnel can add: those of the
 * funnel's niche and its region's language (pages.main_vsls_search, like
 * dayone-main's A/B picker), in status order then the most recent; `query`
 * narrows them to the ones whose title, copywriter, editor or mechanism
 * contain every word. `videoId` is the VTurb player the VSL pipeline recorded
 * (the first).
 */
export async function searchProducedVsls(mainFunnelId: string, query: string, limit = 50): Promise<ProducedVsl[]> {
  if (!UUID_RE.test(mainFunnelId)) return [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // The database filters and orders: only the page of results comes back.
  const { data, error } = await supabaseService().rpc("main_vsls_search", { p_main_funnel: mainFunnelId, p_words: words, p_limit: limit });
  throwIf(error, "main_vsls_search");
  return ((data as (RawVsl & { vsl_id: string; video_ids: string[] | null })[] | null) ?? []).map((v) => ({
    ...toVsl(v.vsl_id, v),
    videoId: v.video_ids?.find((id) => /^[0-9a-f]{24}$/.test(id)) ?? null,
  }));
}

/**
 * A funnel's VSLs tab (by dayone-main funnel id): its VSL split
 * (pages.funnels.vsl). Each video gets its VSL: by the VTurb player id the VSL
 * pipeline recorded, otherwise by name. null = no such funnel.
 */
export async function getFunnelVslPanel(mainFunnelId: string): Promise<FunnelVslPanel | null> {
  if (!UUID_RE.test(mainFunnelId)) return null;
  // One call (pages.funnel_vsl_panel): the split plus only the VSLs that can match its videos.
  const { data, error } = await supabaseService().rpc("funnel_vsl_panel", { p_main_funnel: mainFunnelId });
  throwIf(error, "funnel_vsl_panel");
  type Panel = {
    id: string;
    updated_at: string | null;
    vsl: Record<string, { weight: number; name: string | null }> | null;
    vsls: (RawVsl & { vsl_id: string; video_ids: string[] | null })[];
  };
  const r = data as Panel | null;
  if (!r) return null;

  const byPlayer = new Map<string, FunnelVsl>();
  const byTitle = new Map<string, FunnelVsl>();
  for (const v of r.vsls ?? []) {
    const vsl = toVsl(v.vsl_id, v);
    for (const id of v.video_ids ?? []) if (!byPlayer.has(id)) byPlayer.set(id, vsl);
    const key = titleKey(v.title);
    if (key && !byTitle.has(key)) byTitle.set(key, vsl);
  }
  return {
    funnelRowId: r.id,
    version: r.updated_at,
    videos: Object.entries(r.vsl ?? {})
      .map(([id, v]) => ({ id, name: v.name, weight: Number(v.weight) || 0, vsl: byPlayer.get(id) ?? byTitle.get(titleKey(v.name)) ?? null }))
      .sort((a, b) => b.weight - a.weight || (a.name ?? "").localeCompare(b.name ?? "")),
  };
}

export type FunnelCopy = {
  domain_id: string;
  domain: string;
  page_id: string;
  page_name: string;
  status: PageStatus;
  /** The funnel slug in the copy (`/`, or the first one with steps) and its variants. */
  slug: string;
  versions: ScannedVersion[];
};

export type FunnelPageRef = { id: string; funnelId: string; mainFunnelId: string | null; name: string; status: PageStatus };

export type FunnelDetail = {
  page: FunnelPageRef;
  /** The variants of the page's main slug in the library. */
  versions: ScannedVersion[];
  copies: FunnelCopy[];
};

/** A funnel page, its samples and its copies on the domains (with each copy's samples). */
export async function getFunnelDetail(pageId: string): Promise<FunnelDetail | null> {
  const db = supabaseService();
  const found = await db.rpc("funnel_page_find", { p_page: pageId });
  throwIf(found.error, "funnel_page_find");
  const funnelId = found.data as string | null;
  if (!funnelId) return null;
  const row = (await funnelPages([funnelId])).find((r) => r.page_id === pageId);
  if (!row) return null;
  const [root, copies, domains] = await Promise.all([
    db.rpc("funnel_slug_get", { p_funnel: funnelId, p_page: pageId, p_slug: rootSlug(row.slugs) }),
    sitePages(null),
    db.from("domains").select("id,domain"),
  ]);
  throwIf(root.error, "funnel_slug_get");
  throwIf(domains.error, "getFunnelDetail(domains)");
  const names = new Map(((domains.data ?? []) as { id: string; domain: string }[]).map((d) => [d.id, d.domain]));
  const mine = copies.filter((c) => c.funnel_page_id === pageId);

  const out: FunnelCopy[] = [];
  for (const c of mine) {
    // The slug with steps: `/` if it has them, otherwise the first one that does.
    const order = [...c.slugs].sort((a, b) => (a.slug === "/" ? -1 : b.slug === "/" ? 1 : a.slug.localeCompare(b.slug)));
    let hit: { slug: string; versions: ScannedVersion[] } | null = null;
    for (const s of order) {
      const got = await db.rpc("domain_slug_get", { p_domain: c.domain_id, p_page: c.page_id, p_slug: s.slug });
      throwIf(got.error, "domain_slug_get");
      const versions = scanFunnel((got.data as { content: string }[] | null)?.[0]?.content ?? "");
      if (versions.length) {
        hit = { slug: s.slug, versions };
        break;
      }
    }
    out.push({
      domain_id: c.domain_id,
      domain: names.get(c.domain_id) ?? c.domain_id,
      page_id: c.page_id,
      page_name: c.name,
      status: c.status,
      slug: hit?.slug ?? "/",
      versions: hit?.versions ?? [],
    });
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain));
  return {
    page: { id: row.page_id, funnelId, mainFunnelId: row.main_funnel_id, name: row.name, status: row.status },
    versions: scanFunnel((root.data as { content: string }[] | null)?.[0]?.content ?? ""),
    copies: out,
  };
}

export type FunnelPageEditorData = {
  funnelId: string;
  mainFunnelId: string | null;
  /** The page in the editor's format (kind FUNNEL; template fields that don't exist here come back empty). */
  page: Page;
  /** The slugs; `id` = path. */
  slugs: PageSlugSummary[];
  slug: PageSlug;
};

/**
 * A funnel page (pages.funnels) opened in the editor, at the requested slug (or
 * the root, or the first one). null if the page or the slug doesn't exist.
 */
export async function getFunnelPageForEditor(pageId: string, slugPath: string | null): Promise<FunnelPageEditorData | null> {
  const db = supabaseService();
  const found = await db.rpc("funnel_page_find", { p_page: pageId });
  throwIf(found.error, "funnel_page_find");
  const funnelId = found.data as string | null;
  if (!funnelId) return null;
  const row = (await funnelPages([funnelId])).find((r) => r.page_id === pageId);
  if (!row) return null;

  const slugs: PageSlugSummary[] = row.slugs.map((s) => ({
    id: s.slug,
    page_id: row.page_id,
    slug: s.slug,
    title: s.title,
    content_type: s.content_type,
    content_hash: s.content_hash,
    is_active: s.is_active,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));
  const current = slugPath ? slugs.find((s) => s.slug === slugPath) : slugs.find((s) => s.slug === rootSlug(slugs));
  if (!current) return null;

  const got = await db.rpc("funnel_slug_get", { p_funnel: funnelId, p_page: pageId, p_slug: current.slug });
  throwIf(got.error, "funnel_slug_get");
  const content = (got.data as { content: string }[] | null)?.[0]?.content;
  if (content === undefined) return null;

  return {
    funnelId,
    mainFunnelId: row.main_funnel_id,
    page: { id: row.page_id, name: row.name, kind: "FUNNEL", status: row.status, notes: row.notes, folder: null, created_at: row.created_at, updated_at: row.updated_at },
    slugs,
    slug: { ...current, content },
  };
}

/** A page's slugs in the editor's format (`id` = path, root first). */
function editorSlugs(pageId: string, slugs: SiteSlugSummary[]): PageSlugSummary[] {
  return [...slugs]
    .sort((a, b) => (a.slug === "/" ? -1 : b.slug === "/" ? 1 : a.slug.localeCompare(b.slug)))
    .map((s) => ({
      id: s.slug,
      page_id: pageId,
      slug: s.slug,
      title: s.title,
      content_type: s.content_type,
      content_hash: s.content_hash,
      is_active: s.is_active,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));
}

export type TemplateEditorData = { page: Page; slugs: PageSlugSummary[]; slug: PageSlug };

/**
 * A template opened in the editor, at the requested slug (or the root, or the first one).
 * null if the template or the slug doesn't exist.
 */
export async function getTemplateForEditor(pageId: string, slugPath: string | null): Promise<TemplateEditorData | null> {
  if (!UUID_RE.test(pageId)) return null;
  const row = (await pagesSummary([pageId], "TEMPLATE"))[0];
  if (!row) return null;
  const slugs = editorSlugs(row.id, row.slugs);
  const current = slugPath ? slugs.find((s) => s.slug === slugPath) : slugs[0];
  if (!current) return null;

  const got = await supabaseService().rpc("page_slug_get", { p_page: pageId, p_slug: current.slug });
  throwIf(got.error, "page_slug_get");
  const content = (got.data as { content: string }[] | null)?.[0]?.content;
  if (content === undefined) return null;
  return { page: asPage(row), slugs, slug: { ...current, content } };
}

export type TemplateOption = PageRef & { slugs_count: number };

/** Templates to copy to a domain (archived ones are left out). */
export async function listTemplates(): Promise<TemplateOption[]> {
  const rows = await pagesSummary(null, "TEMPLATE");
  return rows
    .filter((r) => r.status !== "ARCHIVED")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, status: r.status, slugs_count: r.slugs.length }));
}

export type DomainPageEditorData = {
  domain: Pick<Domain, "id" | "domain" | "placeholders">;
  /** The page in the editor's format (template fields that don't exist here come back empty). */
  page: Page;
  /** The slugs; `id` = path. */
  slugs: PageSlugSummary[];
  slug: PageSlug;
};

/**
 * A page from domains.site opened in the editor, at the requested slug (or the
 * root, or the first one). null if the domain, the page or the slug doesn't exist.
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
    page: { id: row.page_id, name: row.name, kind: row.kind, status: row.status, notes: null, folder: null, created_at: row.created_at, updated_at: row.updated_at },
    slugs,
    slug: { ...current, content },
  };
}

export type Overview = {
  domains: number;
  domainsActive: number;
  /** Templates. */
  pages: number;
  /** Pages the domains serve (their copies). */
  domainPages: number;
};

// ── Traffic (hits) ───────────────────────────────────────────────────────────

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

/** Filters for the dashboard reads. Empty list = no filter. */
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

/** Counters for the period (for the cards). */
export async function hitStats(since: Date, filter: HitFilter = {}): Promise<HitStats> {
  const { data, error } = await supabaseService().rpc("hit_stats", { p_since: since.toISOString(), ...filterArgs(filter) });
  throwIf(error, "hitStats");
  const r = (data as Record<string, unknown>[] | null)?.[0];
  return { total: n(r?.total), served: n(r?.served), blocked: n(r?.blocked), bots: n(r?.bots), uniques: n(r?.uniques) };
}

/** Series per bucket (for the chart), gaps already filled. `origin` aligns the buckets (e.g. local midnight). */
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

/** Last N hits (for the Access Logs), since `since` when given. */
export async function recentHits(limit = 20, since: Date | null = null, filter: HitFilter = {}): Promise<HitRow[]> {
  const { data, error } = await supabaseService().rpc("recent_hits", {
    p_limit: limit,
    p_since: since?.toISOString() ?? null,
    ...filterArgs(filter),
  });
  throwIf(error, "recentHits");
  return (data as HitRow[] | null) ?? [];
}

/** Countries with hits in the period (for the country filter), most frequent first. */
export async function hitCountries(since: Date, domainId: string | null = null): Promise<{ country: string; hits: number }[]> {
  const { data, error } = await supabaseService().rpc("hit_countries", { p_since: since.toISOString(), p_domain: domainId });
  throwIf(error, "hitCountries");
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({ country: String(r.country), hits: n(r.hits) }));
}

export type UnregisteredHost = { domain: string; hits: number; bots: number; last_seen: string };

/**
 * Hosts that reached the server (pages.hits) and aren't registered, already
 * normalized like pages.domains (no www.), from most recently seen to
 * oldest. `since` null = the whole history. Rules in pages.unregistered_hosts.
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

/** A hit with everything pages.hits stores (for the Logs screen). */
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
  /** Raw query string, without the "?". */
  query: string | null;
  /** Location returned when the hit was a redirect (the final URL). */
  redirect_url: string | null;
  /** Visit id (cookie dop_v) when the response was an HTML page with the load notice. */
  visit_id: string | null;
  /** The rule that caught the click (pages.rules): its label (Bot, Suspicious), name and reason; null = no rule. */
  rule_label: string | null;
  rule: string | null;
  rule_reason: string | null;
  /** The Accept-Language header as the browser sent it. */
  accept_language: string | null;
  /** Registered domain (pages.domains), not the request's host. */
  domain: string | null;
  page_name: string | null;
  /** The browser's notice that the page loaded (pages.hits.loaded_at/load_ms); null if it never came. */
  load: { loaded_at: string; load_ms: number | null } | null;
};

/**
 * A page of hits, newest to oldest. Cursor pagination:
 * `beforeId` = id of the last one on the previous page (the created_at index follows
 * the same order as the id, which is IDENTITY). Fetches one extra to know if there's a next page.
 */
export async function listHits(opts: { domainId?: string | null; beforeId?: number | null; limit?: number } = {}): Promise<{ rows: HitLogRow[]; hasMore: boolean }> {
  const limit = opts.limit ?? 100;
  const db = supabaseService();
  let q = db
    .from("hits")
    .select(
      "id, created_at, domain_id, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip, user_agent, " +
        "hostname, asn, as_name, cookies, region, route_id, page_id, slug, decision, query, redirect_url, visit_id, rule_label, rule, rule_reason, " +
        "loaded_at, load_ms, accept_language, domains(domain)",
    )
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (opts.domainId) q = q.eq("domain_id", opts.domainId);
  if (opts.beforeId) q = q.lt("id", opts.beforeId);
  const { data, error } = await q;
  throwIf(error, "listHits");

  type Raw = Omit<HitLogRow, "domain" | "page_name" | "load"> & { loaded_at: string | null; load_ms: number | null; domains: { domain: string } | null };
  const raw = (data as unknown as Raw[] | null) ?? [];
  const rows = raw.slice(0, limit);

  // page_id has no FK (the page may have been deleted), so the name comes from a second read, of pages.pages.
  const pageIds = [...new Set(rows.map((r) => r.page_id).filter((id): id is string => id !== null))];
  const pageNames = new Map<string, string>();
  if (pageIds.length > 0) {
    const named = await db.from("pages").select("id, name").in("id", pageIds);
    throwIf(named.error, "listHits (pages)");
    for (const p of (named.data as Pick<Page, "id" | "name">[] | null) ?? []) pageNames.set(p.id, p.name);
  }

  return {
    rows: rows.map(({ domains, loaded_at, load_ms, ...r }) => ({
      ...r,
      domain: domains?.domain ?? null,
      page_name: r.page_id ? (pageNames.get(r.page_id) ?? null) : null,
      load: loaded_at ? { loaded_at, load_ms } : null,
    })),
    hasMore: raw.length > limit,
  };
}

export async function countOverview(): Promise<Overview> {
  const db = supabaseService();
  const head = { count: "exact" as const, head: true };
  const [d, da, p, domainPages] = await Promise.all([
    db.from("domains").select("id", head),
    db.from("domains").select("id", head).eq("status", "ACTIVE"),
    db.from("pages").select("id", head).eq("scope", "TEMPLATE"),
    db.from("pages").select("id", head).eq("scope", "DOMAIN"),
  ]);
  return {
    domains: d.count ?? 0,
    domainsActive: da.count ?? 0,
    pages: p.count ?? 0,
    domainPages: domainPages.count ?? 0,
  };
}
