/**
 * Types and vocabularies of the `pages` schema.
 *
 * The UPPERCASE values are the database CHECKs; the labels are what the
 * screen shows. Whoever needs the value uses the constant; whoever needs the
 * text uses the labels map. There's no third place.
 */

/**
 * Page kinds. FUNNEL = funnel page (Funnel screen) and its copies on the
 * domains; a template is never FUNNEL (TEMPLATE_KINDS).
 */
export const PAGE_KINDS = ["PRESELL", "ADVERTORIAL", "VSL", "CHECKOUT", "SAFE", "OTHER", "FUNNEL"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  PRESELL: "Presell",
  ADVERTORIAL: "Advertorial",
  VSL: "VSL",
  CHECKOUT: "Checkout",
  SAFE: "Institutional",
  OTHER: "Other",
  FUNNEL: "Funnel",
};

export const PAGE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];
export const PAGE_STATUS_LABELS: Record<PageStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

/** Who a domain is for. A label: serving does not depend on it. */
export const DOMAIN_TYPES = ["MEDIA_BUYER", "VENDOR"] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];
export const DOMAIN_TYPE_LABELS: Record<DomainType, string> = {
  MEDIA_BUYER: "Media Buyer",
  VENDOR: "Vendor",
};
export function isDomainType(v: unknown): v is DomainType {
  return typeof v === "string" && (DOMAIN_TYPES as readonly string[]).includes(v);
}

export const DOMAIN_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
export const DOMAIN_STATUS_LABELS: Record<DomainStatus, string> = {
  ACTIVE: "Active",
  PAUSED: "Paused",
  ARCHIVED: "Archived",
};

/**
 * A page (pages.pages): a template, a domain's page or a funnel's page.
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
 * folder as a path (pages.pages.folder, "Funnels/F23/White") and the screen
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

/** The kinds a template (pages.pages) can have: all but FUNNEL. */
export const TEMPLATE_KINDS = PAGE_KINDS.filter((k): k is Exclude<PageKind, "FUNNEL"> => k !== "FUNNEL");
export function isTemplateKind(v: unknown): v is Exclude<PageKind, "FUNNEL"> {
  return typeof v === "string" && (TEMPLATE_KINDS as readonly string[]).includes(v);
}
export function isPageStatus(v: unknown): v is PageStatus {
  return typeof v === "string" && (PAGE_STATUSES as readonly string[]).includes(v);
}
