import { supabaseService } from "@/lib/supabase/service";
import { checkoutValues } from "./checkout-links";
import { resolveRange, type RangeKey } from "./dashboard-filters";
import { placeholderValues } from "./placeholders";
import { listTemplates } from "./queries";
import type { Page, PageKind, PageSlug, PageSlugSummary, PageStatus, VendorPlatform } from "./types";
import { emptyConfig, upsellConfigSchema, type UpsellConfig, type UpsellStepId } from "./upsell-types";
import { vendorFolder } from "./vendor-paths";
import { vendorPlaceholderValues } from "./vendor";

/**
 * The upsell funnels of the vendor pages (pages.upsell_funnels), for Server
 * Components and actions (server-only; the shared rules are in upsell-types.ts).
 * A database error here THROWS, like the other queries modules.
 */

function throwIf(error: { message: string } | null, where: string) {
  if (error) throw new Error(`${where}: ${error.message}`);
}

/** A stored config as the screen uses it (an invalid one — never expected — reads as empty). */
export function parseConfig(raw: unknown): UpsellConfig {
  const parsed = upsellConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyConfig();
}

type FunnelRow = { id: string; page_id: string; name: string; live: unknown; draft: unknown; live_at: string | null; updated_at: string };
type VendorPageRow = { id: string; name: string; platform: string | null; product_id: string | null; status: string };

/** The domains serving each of these pages (their lists name them). */
async function domainsOf(pageIds: string[]): Promise<Map<string, { id: string; domain: string }[]>> {
  const out = new Map<string, { id: string; domain: string }[]>();
  if (pageIds.length === 0) return out;
  const { data, error } = await supabaseService().from("domains").select("id,domain,page").eq("type", "VENDOR");
  throwIf(error, "domainsOf");
  for (const d of (data as { id: string; domain: string; page: Record<string, unknown> }[] | null) ?? []) {
    for (const id of Object.keys(d.page ?? {})) {
      if (pageIds.includes(id)) out.set(id, [...(out.get(id) ?? []), { id: d.id, domain: d.domain }]);
    }
  }
  return out;
}

export type UpsellFunnelListItem = {
  id: string;
  name: string;
  pageName: string;
  platform: string | null;
  domains: string[];
  steps: number;
  liveAt: string | null;
  hasDraft: boolean;
};

/** Every upsell funnel, and the vendor pages that have none yet (for "New upsell funnel"). */
export async function listUpsellFunnels(): Promise<{ funnels: UpsellFunnelListItem[]; freePages: { id: string; name: string; platform: string | null }[] }> {
  const db = supabaseService();
  const [funnels, pages] = await Promise.all([
    db.from("upsell_funnels").select("id,page_id,name,live,draft,live_at,updated_at").order("created_at"),
    // A funnel belongs to a vendor site page; the upsell pages are its versions, not funnels of their own.
    db.from("page_content").select("id,name,platform,product_id,status").eq("scope", "VENDOR").neq("kind", "UPSELL").order("name"),
  ]);
  throwIf(funnels.error, "listUpsellFunnels");
  throwIf(pages.error, "listUpsellFunnels");
  const rows = (funnels.data as FunnelRow[] | null) ?? [];
  const vendorPages = (pages.data as VendorPageRow[] | null) ?? [];
  const byId = new Map(vendorPages.map((p) => [p.id, p]));
  const domains = await domainsOf(rows.map((r) => r.page_id));
  const taken = new Set(rows.map((r) => r.page_id));
  return {
    funnels: rows.map((r) => ({
      id: r.id,
      name: r.name,
      pageName: byId.get(r.page_id)?.name ?? "—",
      platform: byId.get(r.page_id)?.platform ?? null,
      domains: (domains.get(r.page_id) ?? []).map((d) => d.domain),
      steps: parseConfig(r.live).steps.length,
      liveAt: r.live_at,
      hasDraft: r.draft !== null,
    })),
    freePages: vendorPages.filter((p) => !taken.has(p.id)).map((p) => ({ id: p.id, name: p.name, platform: p.platform })),
  };
}

/** One row of pages.upsell_funnel_stats: served responses (hits.upsell) and distinct IPs. `page` = the upsell page's id. */
export type UpsellServed = { step: string; grp: string | null; flow: string | null; page: string | null; offer: string | null; video: string | null; hits: number; visitors: number };
/** One row of pages.upsell_funnel_answers: the accept/decline events dot recorded. `page` = the upsell page's id. */
export type UpsellAnswer = { origin: string; event: string; offer: string | null; grp: string | null; flow: string | null; page: string | null; n: number };
/**
 * One row of pages.upsell_funnel_revenue: the platform's sales of an offer code (core.orders),
 * each tied to the buyer's accept on our pages — that answer's step (origin), group, flow and page.
 * `match_kind`: "exact" = tied by the order (its vendor_purchase in dot shares the accept's dotid),
 * "ip6h" = only by the same IP within 6 h (an estimate).
 */
export type UpsellRevenue = {
  origin: string;
  event: string;
  offer: string;
  grp: string | null;
  flow: string | null;
  page: string | null;
  sales: number;
  revenue: number;
  match_kind: "exact" | "ip6h";
};

/** The editor's numbers for a period (the Dashboard's ranges). */
export type UpsellMetrics = { range: RangeKey; since: string; served: UpsellServed[]; answers: UpsellAnswer[]; revenue: UpsellRevenue[] };

/** The funnel's numbers since the period's start: served responses (hits), dot's answers and the sales tied to them. */
export async function getUpsellMetrics(id: string, range: RangeKey): Promise<UpsellMetrics> {
  const since = resolveRange(range, Date.now()).since.toISOString();
  const db = supabaseService();
  const [served, answers, revenue] = await Promise.all([
    db.rpc("upsell_funnel_stats", { p_funnel: id, p_since: since }),
    db.rpc("upsell_funnel_answers", { p_funnel: id, p_since: since }),
    db.rpc("upsell_funnel_revenue", { p_funnel: id, p_since: since }),
  ]);
  throwIf(served.error, "getUpsellMetrics stats");
  throwIf(answers.error, "getUpsellMetrics answers");
  throwIf(revenue.error, "getUpsellMetrics revenue");
  return {
    range,
    since,
    served: ((served.data as UpsellServed[] | null) ?? []).map((r) => ({ ...r, hits: Number(r.hits), visitors: Number(r.visitors) })),
    answers: ((answers.data as UpsellAnswer[] | null) ?? []).map((r) => ({ ...r, n: Number(r.n) })),
    // A row without match_kind (the function before 20261015e) was tied by IP: an estimate.
    revenue: ((revenue.data as UpsellRevenue[] | null) ?? []).map((r) => ({ ...r, sales: Number(r.sales), revenue: Number(r.revenue), match_kind: r.match_kind === "exact" ? "exact" : "ip6h" })),
  };
}

/** A video uploaded from the VSL stage, on its way to VTurb (pages.upsell_videos; dayone-main's worker). */
export type UpsellVideo = {
  id: number;
  step: string;
  group_id: string;
  name: string;
  size_bytes: number | null;
  state: "pending" | "uploading" | "transcoding" | "done" | "failed";
  player_id: string | null;
  error_message: string | null;
  attempt_count: number;
  added_at: string | null;
  created_at: string;
  finished_at: string | null;
};

/** A funnel's uploads, newest first. */
export async function listUpsellVideos(funnelId: string): Promise<UpsellVideo[]> {
  const { data, error } = await supabaseService().rpc("upsell_videos_for", { p_funnel: funnelId });
  throwIf(error, "listUpsellVideos");
  return ((data as UpsellVideo[] | null) ?? []).map((v) => ({ ...v, id: Number(v.id), size_bytes: v.size_bytes === null ? null : Number(v.size_bytes) }));
}

/** An upsell page a version can name: VENDOR + kind UPSELL, the vendor page's product and platform. */
export type UpsellPageOption = { id: string; name: string; status: string };

export type UpsellEditorData = {
  id: string;
  name: string;
  updatedAt: string;
  liveAt: string | null;
  live: UpsellConfig;
  draft: UpsellConfig | null;
  /** The vendor page; `folder` = where its slugs live ("/bg", or "" at the root: vendor-paths.ts) — its steps are also served there. */
  page: { id: string; name: string; platform: string | null; folder: string };
  /** The upsell pages of the vendor page's product and platform (the page versions' picker). */
  upsellPages: UpsellPageOption[];
  /** The videos uploaded from the VSL stage (to VTurb, through dayone-main's worker). */
  videos: UpsellVideo[];
  domains: { id: string; domain: string }[];
  /** The product's checkout keys on the page's platform → their values (the CTA and downsell offers). */
  checkout: Record<string, string>;
  history: { id: number; summary: string | null; publishedAt: string }[];
  /** The period's numbers (the period selector reloads them with loadUpsellMetrics). */
  metrics: UpsellMetrics;
  /** For "New upsell page": the templates, and the product's vendor and upsell pages with their HTML slugs. */
  templates: { id: string; name: string }[];
  copySources: UpsellCopySource[];
};

/** A page of the vendor product whose slug a new upsell page can copy (any platform; its upsell pages too). */
export type UpsellCopySource = { id: string; name: string; kind: PageKind; platform: string | null; slugs: string[] };

type SummaryRow = { id: string; name: string; kind: PageKind; status: PageStatus; notes: string | null; created_at: string; updated_at: string; slugs: SlugSummaryRow[] };
type SlugSummaryRow = { slug: string; title: string | null; is_active: boolean; content_type: string; content_hash: string; created_at: string; updated_at: string };

/** Pages of scope VENDOR without the HTML (pages.pages_summary: never `select("*")` on page_content). */
async function vendorSummaries(ids: string[]): Promise<SummaryRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseService().rpc("pages_summary", { p_ids: ids, p_scope: "VENDOR" });
  throwIf(error, "pages_summary");
  return (data as SummaryRow[] | null) ?? [];
}

const isHtmlSlug = (s: SlugSummaryRow) => s.content_type.startsWith("text/html");

/** The vendor product's pages (every platform) and their HTML slugs, for "Copy a page". */
async function copySourcesOf(productId: string | null): Promise<UpsellCopySource[]> {
  if (!productId) return [];
  const { data, error } = await supabaseService().from("page_content").select("id,platform").eq("scope", "VENDOR").eq("product_id", productId).neq("status", "ARCHIVED");
  throwIf(error, "copySourcesOf");
  const rows = (data as { id: string; platform: string | null }[] | null) ?? [];
  const platformOf = new Map(rows.map((r) => [r.id, r.platform]));
  const pages = await vendorSummaries(rows.map((r) => r.id));
  return pages
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, platform: platformOf.get(p.id) ?? null, slugs: p.slugs.filter(isHtmlSlug).map((s) => s.slug).sort() }))
    .filter((p) => p.slugs.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything the editor needs, with the numbers of the period. null = no such funnel. */
export async function getUpsellEditor(id: string, range: RangeKey): Promise<UpsellEditorData | null> {
  const db = supabaseService();
  const { data: row, error } = await db.from("upsell_funnels").select("id,page_id,name,live,draft,live_at,updated_at").eq("id", id).maybeSingle();
  throwIf(error, "getUpsellEditor");
  const f = row as FunnelRow | null;
  if (!f) return null;

  const [page, history, metrics, domains, videos, templates, own] = await Promise.all([
    db.from("page_content").select("id,name,platform,product_id,status").eq("id", f.page_id).maybeSingle(),
    db.from("upsell_funnel_history").select("id,summary,published_at").eq("funnel_id", id).order("published_at", { ascending: false }).limit(20),
    getUpsellMetrics(id, range),
    domainsOf([f.page_id]),
    listUpsellVideos(f.id),
    listTemplates(),
    vendorSummaries([f.page_id]),
  ]);
  throwIf(page.error, "getUpsellEditor page");
  throwIf(history.error, "getUpsellEditor history");
  const p = page.data as VendorPageRow | null;
  const copySources = await copySourcesOf(p?.product_id ?? null);

  // The upsell pages of the same product and platform (a page without either matches only pages without it, like the database).
  let upsellPages: UpsellPageOption[] = [];
  if (p) {
    let q = db.from("page_content").select("id,name,status").eq("scope", "VENDOR").eq("kind", "UPSELL").neq("status", "ARCHIVED");
    q = p.product_id ? q.eq("product_id", p.product_id) : q.is("product_id", null);
    q = p.platform ? q.eq("platform", p.platform) : q.is("platform", null);
    const up = await q.order("name");
    throwIf(up.error, "getUpsellEditor upsell pages");
    upsellPages = (up.data as UpsellPageOption[] | null) ?? [];
  }

  let checkout: Record<string, string> = {};
  if (p?.product_id && p.platform) {
    const product = await db.from("products").select("checkout_links").eq("id", p.product_id).maybeSingle();
    throwIf(product.error, "getUpsellEditor checkout");
    const values = checkoutValues((product.data as { checkout_links: unknown } | null)?.checkout_links, p.platform as VendorPlatform);
    checkout = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.replace(/^checkout\./, ""), v]));
  }

  return {
    id: f.id,
    name: f.name,
    updatedAt: f.updated_at,
    liveAt: f.live_at,
    live: parseConfig(f.live),
    draft: f.draft === null ? null : parseConfig(f.draft),
    page: { id: f.page_id, name: p?.name ?? "—", platform: p?.platform ?? null, folder: vendorFolder((own[0]?.slugs ?? []).map((s) => s.slug)) },
    upsellPages,
    videos,
    domains: domains.get(f.page_id) ?? [],
    checkout,
    history: ((history.data as { id: number; summary: string | null; published_at: string }[] | null) ?? []).map((h) => ({ id: h.id, summary: h.summary, publishedAt: h.published_at })),
    metrics,
    templates: templates.map((t) => ({ id: t.id, name: t.name })),
    copySources,
  };
}

// ── An upsell page in the editor (/upsells/[id]/pages/[pageId]) ─────────────

export type UpsellPageEditorData = {
  funnel: { id: string; name: string };
  page: Page;
  slugs: PageSlugSummary[];
  slug: PageSlug;
  /** The vendor domain the preview takes its address and company data from (null = not on a domain). */
  domain: string | null;
  /** The preview's values: the domain's, the product's checkout links and — opened from a group — its `upsell.*`. */
  placeholders: Record<string, string>;
};

/**
 * An upsell page of the funnel's vendor product and platform, opened in the
 * editor at the requested slug (or "/", or the first one). With `from` (the
 * group it was opened from), the preview fills {{upsell.offer}} and
 * {{upsell.downsellN}} with that group's largest-share offers. null = no such
 * funnel, page or slug.
 */
export async function getUpsellPageForEditor(
  funnelId: string,
  pageId: string,
  slugPath: string | null,
  from: { step: string; group: string } | null,
): Promise<UpsellPageEditorData | null> {
  const db = supabaseService();
  const { data: row, error } = await db.from("upsell_funnels").select("id,page_id,name,live,draft,live_at,updated_at").eq("id", funnelId).maybeSingle();
  throwIf(error, "getUpsellPageForEditor");
  const f = row as FunnelRow | null;
  if (!f) return null;

  const [vendor, own, summary, domains, checkout] = await Promise.all([
    db.from("page_content").select("product_id,platform").eq("id", f.page_id).maybeSingle(),
    db.from("page_content").select("scope,kind,product_id,platform").eq("id", pageId).maybeSingle(),
    vendorSummaries([pageId]),
    domainsOf([f.page_id]),
    // checkout.<key> and product.*: the vendor page's, since the upsell page has the same product and platform.
    vendorPlaceholderValues(pageId),
  ]);
  throwIf(vendor.error, "getUpsellPageForEditor vendor page");
  throwIf(own.error, "getUpsellPageForEditor page");
  const v = vendor.data as { product_id: string | null; platform: string | null } | null;
  const o = own.data as { scope: string; kind: string; product_id: string | null; platform: string | null } | null;
  const p = summary[0];
  // Only an upsell page of the funnel's product and platform (the ones its versions can name).
  if (!v || !o || !p || o.scope !== "VENDOR" || o.kind !== "UPSELL" || o.product_id !== v.product_id || o.platform !== v.platform) return null;

  const slugs: PageSlugSummary[] = [...p.slugs]
    .sort((a, b) => (a.slug === "/" ? -1 : b.slug === "/" ? 1 : a.slug.localeCompare(b.slug)))
    .map((s) => ({ id: s.slug, page_id: p.id, ...s }));
  const current = slugPath ? slugs.find((s) => s.slug === slugPath) : slugs[0];
  if (!current) return null;
  const got = await db.rpc("page_slug_get", { p_page: pageId, p_slug: current.slug });
  throwIf(got.error, "page_slug_get");
  const content = (got.data as { content: string }[] | null)?.[0]?.content;
  if (content === undefined) return null;

  const domain = (domains.get(f.page_id) ?? [])[0] ?? null;
  let values: Record<string, string> = { ...checkout };
  if (domain) {
    const d = await db.from("domains").select("placeholders").eq("id", domain.id).maybeSingle();
    throwIf(d.error, "getUpsellPageForEditor domain");
    // Preview as an English-speaking visitor at the step's path, like the domain page editor.
    values = placeholderValues({ domain: domain.domain, stored: (d.data as { placeholders: unknown } | null)?.placeholders, vendor: checkout, path: current.slug, lang: "en" });
  }
  if (from) Object.assign(values, upsellOfferValues(parseConfig(f.draft ?? f.live), from, checkout));

  return {
    funnel: { id: f.id, name: f.name },
    page: { id: p.id, name: p.name, kind: p.kind, status: p.status, notes: p.notes, folder: null, created_at: p.created_at, updated_at: p.updated_at },
    slugs,
    slug: { ...current, content },
    domain: domain?.domain ?? null,
    placeholders: values,
  };
}

/** `upsell.offer` and `upsell.downsellN` of a group: its largest-share offer of each, as the checkout value it charges. */
function upsellOfferValues(config: UpsellConfig, from: { step: string; group: string }, checkout: Record<string, string>): Record<string, string> {
  const group = config.steps.find((s) => s.id === (from.step as UpsellStepId))?.groups?.find((g) => g.id === from.group);
  if (!group) return {};
  const top = (list: { offer: string; weight: number }[] | undefined) => [...(list ?? [])].sort((a, b) => b.weight - a.weight)[0]?.offer;
  const value = (key: string | undefined) => (key ? (checkout[`checkout.${key}`] ?? "") : "");
  const out: Record<string, string> = { "upsell.offer": value(top(group.offers)) };
  (group.downsells ?? []).forEach((slot, i) => {
    out[`upsell.downsell${i + 1}`] = value(top(slot));
  });
  return out;
}

/** Whether a page is named by any upsell funnel's live or draft config (it can't be deleted then). */
export async function upsellPageInUse(pageId: string): Promise<boolean> {
  const { data, error } = await supabaseService().from("upsell_funnels").select("live,draft");
  throwIf(error, "upsellPageInUse");
  return ((data as { live: unknown; draft: unknown }[] | null) ?? []).some((r) =>
    [r.live, r.draft].some((c) => c !== null && parseConfig(c).steps.some((s) => (s.groups ?? []).some((g) => Object.values(g.pages).some((list) => list.some((v) => v.page_id === pageId))))),
  );
}

