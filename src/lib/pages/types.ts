/**
 * Types and vocabularies of the `pages` schema.
 *
 * The UPPERCASE values are the database CHECKs; the labels are what the
 * screen shows. Whoever needs the value uses the constant; whoever needs the
 * text uses the labels map. There's no third place.
 */

/**
 * Page kinds. FUNNEL = funnel page (Funnel screen) and its copies on the
 * domains; UPSELL = a vendor page an upsell funnel serves as a step's page
 * version (scope VENDOR only, never on a domain's list). A template is never
 * FUNNEL nor UPSELL (TEMPLATE_KINDS).
 */
export const PAGE_KINDS = ["PRESELL", "ADVERTORIAL", "VSL", "CHECKOUT", "SAFE", "OTHER", "FUNNEL", "UPSELL"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  PRESELL: "Presell",
  ADVERTORIAL: "Advertorial",
  VSL: "VSL",
  CHECKOUT: "Checkout",
  SAFE: "Institutional",
  OTHER: "Other",
  FUNNEL: "Funnel",
  UPSELL: "Upsell",
};

export const PAGE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];
export const PAGE_STATUS_LABELS: Record<PageStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

/** Who a domain is for. Only a VENDOR domain can list a vendor page (pages.domains_page_check); otherwise serving does not depend on it. */
export const DOMAIN_TYPES = ["MEDIA_BUYER", "VENDOR"] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];
export const DOMAIN_TYPE_LABELS: Record<DomainType, string> = {
  MEDIA_BUYER: "Media Buyer",
  VENDOR: "Vendor",
};
export function isDomainType(v: unknown): v is DomainType {
  return typeof v === "string" && (DOMAIN_TYPES as readonly string[]).includes(v);
}

/**
 * The checkout platform a vendor page sells through (pages.page_content.platform,
 * and the keys of pages.products.checkout_links). The core's site packages call
 * them pa, cb, bg, cp and dg.
 */
export const VENDOR_PLATFORMS = ["PAGAMERICAN", "CLICKBANK", "BUYGOODS", "CARTPANDA", "DIGISTORE24"] as const;
export type VendorPlatform = (typeof VENDOR_PLATFORMS)[number];
export const VENDOR_PLATFORM_LABELS: Record<VendorPlatform, string> = {
  PAGAMERICAN: "PagAmerican",
  CLICKBANK: "ClickBank",
  BUYGOODS: "BuyGoods",
  CARTPANDA: "CartPanda",
  DIGISTORE24: "Digistore24",
};
export function isVendorPlatform(v: unknown): v is VendorPlatform {
  return typeof v === "string" && (VENDOR_PLATFORMS as readonly string[]).includes(v);
}

/**
 * What the domain does with a click (the gate reads it per request): ACTIVE =
 * the gate as configured; DISABLED = 404 for every slug; LOCKED = the rules
 * run, but no slug goes to the funnel (always the domain's page); UNLOCKED =
 * the rules are ignored and every slug goes straight to the sub1's funnel, or
 * — when the sub1 names none — to the one picked on the domain's funnel
 * picker (?dop_funnel=); ?dop_page=<page id> pins one page of its split
 * (the dashboard's preview).
 */
export const DOMAIN_STATUSES = ["ACTIVE", "DISABLED", "LOCKED", "UNLOCKED"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
export const DOMAIN_STATUS_LABELS: Record<DomainStatus, string> = {
  ACTIVE: "Active",
  DISABLED: "Disabled",
  LOCKED: "Locked",
  UNLOCKED: "Unlocked",
};
export function isDomainStatus(v: unknown): v is DomainStatus {
  return typeof v === "string" && (DOMAIN_STATUSES as readonly string[]).includes(v);
}

/**
 * A page (pages.page_content): a template, a domain's page or a funnel's page.
 * The slugs and the HTML live in the row's own `slugs` column.
 */
export type Page = {
  id: string;
  name: string;
  kind: PageKind;
  status: PageStatus;
  notes: string | null;
  /** The template's folder as a path ("Funnels/F23/White"); null = the root. */
  folder: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A folder of the Templates screen. Folders aren't stored: a template keeps its
 * folder as a path (pages.page_content.folder, "Funnels/F23/White") and the screen
 * derives the tree from the paths (folders.ts). `id` is the full path.
 */
export type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
};

/** A page slug. `id` is the path itself (unique within the page). */
export type PageSlug = {
  id: string;
  page_id: string;
  slug: string;
  title: string | null;
  content: string;
  content_type: string;
  content_hash: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** The slug without its content — for lists and the sidebar. */
export type PageSlugSummary = Omit<PageSlug, "content">;

export type Domain = {
  id: string;
  domain: string;
  /** null = not chosen yet. */
  type: DomainType | null;
  status: DomainStatus;
  /** The slugs where a clean click goes to the funnel of its sub1 (besides "/"). */
  gate_slugs: string[];
  /** Values of the {{key}} placeholders of the domain's pages (see placeholders.ts). */
  placeholders: Record<string, unknown>;
  settings: Record<string, unknown>;
  notes: string | null;
  last_checked_at: string | null;
  last_check_ok: boolean | null;
  last_check_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Short reference to a page, as embedded in domains and routes. */
export type PageRef = Pick<Page, "id" | "name" | "kind" | "status">;

export function isPageKind(v: unknown): v is PageKind {
  return typeof v === "string" && (PAGE_KINDS as readonly string[]).includes(v);
}

/** The kinds a template (pages.page_content) can have: all but FUNNEL and UPSELL. */
export type TemplateKind = Exclude<PageKind, "FUNNEL" | "UPSELL">;
export const TEMPLATE_KINDS = PAGE_KINDS.filter((k): k is TemplateKind => k !== "FUNNEL" && k !== "UPSELL");
export function isTemplateKind(v: unknown): v is TemplateKind {
  return typeof v === "string" && (TEMPLATE_KINDS as readonly string[]).includes(v);
}
export function isPageStatus(v: unknown): v is PageStatus {
  return typeof v === "string" && (PAGE_STATUSES as readonly string[]).includes(v);
}
