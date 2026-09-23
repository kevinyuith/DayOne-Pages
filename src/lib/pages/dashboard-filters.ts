/**
 * Filtros do dashboard (`/`): período, domínio, resultado, dispositivo, país e
 * "esconder bots". Vivem na URL (?range=7d&domain=<id>&outcome=served,blocked
 * &device=mobile&country=US,BR&bots=hide), que a página lê no servidor; assim
 * um filtro sobrevive a refresh e pode ser compartilhado. Sem dependência de
 * servidor: a barra de controles (client) usa o mesmo módulo para montar a URL.
 */

import type { HitBucket } from "@/lib/pages/queries";
import { localDateKey, localMidnight } from "@/lib/time-zone";

export const RANGES = [
  { key: "today", label: "Today", short: "today" },
  { key: "24h", label: "Last 24 hours", short: "24h" },
  { key: "7d", label: "Last 7 days", short: "7d" },
  { key: "30d", label: "Last 30 days", short: "30d" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

const DEFAULT_RANGE: RangeKey = "24h";

/** Os resultados que dá para filtrar (os de pages.hits, menos o "other" residual). */
export const OUTCOME_KEYS = ["served", "redirect", "blocked", "bot", "notfound", "error"] as const;
export const DEVICE_KEYS = ["desktop", "mobile", "tablet"] as const;

export type DashboardFilters = {
  range: RangeKey;
  /** id em pages.domains, ou null para todos. */
  domain: string | null;
  outcomes: string[];
  devices: string[];
  /** ISO-2, maiúsculo. */
  countries: string[];
  hideBots: boolean;
};

type SearchParams = { [key: string]: string | string[] | undefined };

function list(v: string | string[] | undefined): string[] {
  const raw = Array.isArray(v) ? v.join(",") : (v ?? "");
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Lê e valida os filtros da URL; o que não for reconhecido é ignorado. */
export function parseDashboardFilters(sp: SearchParams, domainIds: string[]): DashboardFilters {
  const range = RANGES.find((r) => r.key === sp.range)?.key ?? DEFAULT_RANGE;
  const domain = typeof sp.domain === "string" && domainIds.includes(sp.domain) ? sp.domain : null;
  return {
    range,
    domain,
    outcomes: list(sp.outcome).filter((o) => (OUTCOME_KEYS as readonly string[]).includes(o)),
    devices: list(sp.device).filter((d) => (DEVICE_KEYS as readonly string[]).includes(d)),
    countries: list(sp.country)
      .map((c) => c.toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c)),
    hideBots: sp.bots === "hide",
  };
}

/** URL do dashboard para os filtros dados (o que é padrão fica de fora). */
export function dashboardHref(f: DashboardFilters): string {
  const qs = new URLSearchParams();
  if (f.range !== DEFAULT_RANGE) qs.set("range", f.range);
  if (f.domain) qs.set("domain", f.domain);
  if (f.outcomes.length) qs.set("outcome", f.outcomes.join(","));
  if (f.devices.length) qs.set("device", f.devices.join(","));
  if (f.countries.length) qs.set("country", f.countries.join(","));
  if (f.hideBots) qs.set("bots", "hide");
  const s = qs.toString();
  return s ? `/?${s}` : "/";
}

/** Quantos grupos do popover "Filters" estão ativos (para o selo do botão). */
export function activeFilterCount(f: DashboardFilters): number {
  return [f.outcomes.length > 0, f.devices.length > 0, f.countries.length > 0, f.hideBots].filter(Boolean).length;
}

// ── Período → janela de tempo ───────────────────────────────────────────────

export type RangeWindow = {
  since: Date;
  /**
   * Tamanho do bucket pedido ao banco. Sempre 1h: o banco não sabe de fuso, e
   * um dia de NY nem sempre tem 24h (horário de verão). A série diária é
   * montada somando as horas por dia local (`foldIntoLocalDays`).
   */
  bucketMinutes: number;
  /** Alinhamento dos buckets: meia-noite local (hora cheia, já que o offset de NY é em horas inteiras). */
  origin: Date;
  granularity: "hour" | "day";
  label: string;
  short: string;
};

export function resolveRange(range: RangeKey, nowMs: number): RangeWindow {
  const midnight = localMidnight(nowMs);
  const r = RANGES.find((x) => x.key === range) ?? RANGES[1];
  const base = { origin: new Date(midnight), bucketMinutes: 60, label: r.label, short: r.short };
  switch (r.key) {
    case "today":
      return { ...base, since: new Date(midnight), granularity: "hour" };
    case "7d":
      // Hoje + os 6 dias anteriores, dias inteiros.
      return { ...base, since: new Date(localMidnight(nowMs, 6)), granularity: "day" };
    case "30d":
      // Até ~720 buckets de 1h: cabe no limite de 1000 linhas do PostgREST.
      return { ...base, since: new Date(localMidnight(nowMs, 29)), granularity: "day" };
    default:
      return { ...base, since: new Date(nowMs - 24 * 60 * 60 * 1000), granularity: "hour" };
  }
}

/** Soma buckets de 1h por dia local; cada dia fica com o instante da sua primeira hora (a meia-noite local). */
export function foldIntoLocalDays(buckets: HitBucket[]): HitBucket[] {
  const days = new Map<string, HitBucket>();
  for (const b of buckets) {
    const key = localDateKey(Date.parse(b.bucket));
    const day = days.get(key);
    if (day) {
      day.served += b.served;
      day.blocked += b.blocked;
      day.bots += b.bots;
    } else {
      days.set(key, { ...b });
    }
  }
  return [...days.values()];
}
