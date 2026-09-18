import type { RouteConditions } from "./conditions";

/**
 * Tipos e vocabulários do schema `pages`.
 *
 * Os valores em MAIÚSCULAS são os CHECKs do banco; os rótulos são o que a
 * tela mostra. Quem precisa do valor usa a constante; quem precisa do texto
 * usa o mapa de rótulos. Não há terceiro lugar.
 */

export const PAGE_KINDS = ["PRESELL", "ADVERTORIAL", "VSL", "CHECKOUT", "SAFE", "OTHER"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  PRESELL: "Presell",
  ADVERTORIAL: "Advertorial",
  VSL: "VSL",
  CHECKOUT: "Checkout",
  SAFE: "Institucional",
  OTHER: "Outra",
};

export const PAGE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];
export const PAGE_STATUS_LABELS: Record<PageStatus, string> = {
  DRAFT: "Rascunho",
  PUBLISHED: "Publicada",
  ARCHIVED: "Arquivada",
};

export const DOMAIN_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
export const DOMAIN_STATUS_LABELS: Record<DomainStatus, string> = {
  ACTIVE: "Ativo",
  PAUSED: "Pausado",
  ARCHIVED: "Arquivado",
};

export const MATCH_TYPES = ["EXACT", "PREFIX", "REGEX", "ANY"] as const;
export type MatchType = (typeof MATCH_TYPES)[number];
export const MATCH_TYPE_LABELS: Record<MatchType, string> = {
  EXACT: "Exato",
  PREFIX: "Prefixo",
  REGEX: "Regex",
  ANY: "Qualquer path",
};

export const ROUTE_ACTIONS = ["SERVE", "REDIRECT", "BLOCK"] as const;
export type RouteAction = (typeof ROUTE_ACTIONS)[number];
export const ROUTE_ACTION_LABELS: Record<RouteAction, string> = {
  SERVE: "Servir página",
  REDIRECT: "Redirecionar",
  BLOCK: "Bloquear",
};

export const REDIRECT_CODES = [301, 302, 307, 308] as const;
export const BLOCK_CODES = [403, 404, 410, 451] as const;

export type Page = {
  id: string;
  name: string;
  kind: PageKind;
  status: PageStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type PageSlug = {
  id: string;
  page_id: string;
  slug: string;
  title: string | null;
  content: string;
  content_type: string;
  content_hash: string;
  is_active: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A slug sem o conteúdo — para listas e barra lateral. */
export type PageSlugSummary = Omit<PageSlug, "content">;

export type Domain = {
  id: string;
  domain: string;
  status: DomainStatus;
  default_page_id: string | null;
  filter: RouteConditions | null;
  filter_pass_page_id: string | null;
  filter_fail_page_id: string | null;
  settings: Record<string, unknown>;
  notes: string | null;
  last_checked_at: string | null;
  last_check_ok: boolean | null;
  last_check_error: string | null;
  created_at: string;
  updated_at: string;
};

export type DomainRoute = {
  id: string;
  domain_id: string;
  name: string | null;
  priority: number;
  is_active: boolean;
  match_type: MatchType;
  path_pattern: string | null;
  conditions: RouteConditions;
  action: RouteAction;
  page_id: string | null;
  slug: string | null;
  redirect_url: string | null;
  status_code: number | null;
  preserve_query: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** Referência curta a uma página, como aparece embutida em domínios e rotas. */
export type PageRef = Pick<Page, "id" | "name" | "kind" | "status">;

export function isPageKind(v: unknown): v is PageKind {
  return typeof v === "string" && (PAGE_KINDS as readonly string[]).includes(v);
}
export function isPageStatus(v: unknown): v is PageStatus {
  return typeof v === "string" && (PAGE_STATUSES as readonly string[]).includes(v);
}
export function isMatchType(v: unknown): v is MatchType {
  return typeof v === "string" && (MATCH_TYPES as readonly string[]).includes(v);
}
export function isRouteAction(v: unknown): v is RouteAction {
  return typeof v === "string" && (ROUTE_ACTIONS as readonly string[]).includes(v);
}
