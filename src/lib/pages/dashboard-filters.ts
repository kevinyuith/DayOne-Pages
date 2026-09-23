/**
 * Filtros do dashboard (`/`): período, domínio, resultado, dispositivo, país e
 * "esconder bots". Vivem na URL (?range=7d&domain=<id>&outcome=served,blocked
 * &device=mobile&country=US,BR&bots=hide), que a página lê no servidor; assim
 * um filtro sobrevive a refresh e pode ser compartilhado. Sem dependência de
 * servidor: a barra de controles (client) usa o mesmo módulo para montar a URL.
 */

/** Fuso dos períodos ("Today" começa à meia-noite daqui) e dos rótulos do gráfico. */
export const DASHBOARD_TZ = "America/Sao_Paulo";

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

/** Meia-noite de hoje no fuso, em ms UTC (pelo offset de agora; São Paulo não tem horário de verão). */
function startOfLocalDay(nowMs: number, tz: string): number {
  const now = new Date(nowMs);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value; // "GMT-03:00" (ou "GMT" em UTC)
  const m = offset?.match(/GMT([+-])(\d{2}):(\d{2})/);
  const offsetMs = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
  const [y, mo, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now)
    .split("-")
    .map(Number);
  return Date.UTC(y, mo - 1, d) - offsetMs;
}

export type RangeWindow = {
  since: Date;
  /** Tamanho do bucket do gráfico. */
  bucketMinutes: number;
  /** Alinhamento dos buckets: meia-noite local, para os dias da série diária baterem. */
  origin: Date;
  granularity: "hour" | "day";
  label: string;
  short: string;
};

export function resolveRange(range: RangeKey, nowMs: number): RangeWindow {
  const midnight = startOfLocalDay(nowMs, DASHBOARD_TZ);
  const DAY = 24 * 60 * 60 * 1000;
  const r = RANGES.find((x) => x.key === range) ?? RANGES[1];
  const base = { origin: new Date(midnight), label: r.label, short: r.short };
  switch (r.key) {
    case "today":
      return { ...base, since: new Date(midnight), bucketMinutes: 60, granularity: "hour" };
    case "7d":
      // Hoje + os 6 dias anteriores, dias inteiros.
      return { ...base, since: new Date(midnight - 6 * DAY), bucketMinutes: 1440, granularity: "day" };
    case "30d":
      return { ...base, since: new Date(midnight - 29 * DAY), bucketMinutes: 1440, granularity: "day" };
    default:
      return { ...base, since: new Date(nowMs - DAY), bucketMinutes: 60, granularity: "hour" };
  }
}
