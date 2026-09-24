/**
 * Dashboard filters (`/`): period, domain, outcome, device, country and
 * "hide bots". They live in the URL (?range=7d&domain=<id>&outcome=served,blocked
 * &device=mobile&country=US,BR&bots=hide), which the page reads on the server; so
 * a filter survives a refresh and can be shared. No server dependency: the
 * control bar (client) uses the same module to build the URL.
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

/** The outcomes you can filter by (those in pages.hits, minus the residual "other"). */
export const OUTCOME_KEYS = ["served", "redirect", "blocked", "bot", "notfound", "error"] as const;
export const DEVICE_KEYS = ["desktop", "mobile", "tablet"] as const;

export type DashboardFilters = {
  range: RangeKey;
  /** id in pages.domains, or null for all. */
  domain: string | null;
  outcomes: string[];
  devices: string[];
  /** ISO-2, uppercase. */
  countries: string[];
  hideBots: boolean;
};

type SearchParams = { [key: string]: string | string[] | undefined };

function list(v: string | string[] | undefined): string[] {
  const raw = Array.isArray(v) ? v.join(",") : (v ?? "");
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Reads and validates the filters from the URL; anything unrecognized is ignored. */
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

/** Dashboard URL for the given filters (defaults are left out). */
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

/** How many groups of the "Filters" popover are active (for the button's badge). */
export function activeFilterCount(f: DashboardFilters): number {
  return [f.outcomes.length > 0, f.devices.length > 0, f.countries.length > 0, f.hideBots].filter(Boolean).length;
}

// ── Period → time window ────────────────────────────────────────────────────

export type RangeWindow = {
  since: Date;
  /**
   * Bucket size requested from the database. Always 1h: the database knows
   * nothing about time zones, and a NY day doesn't always have 24h (daylight
   * saving). The daily series is built by summing the hours per local day
   * (`foldIntoLocalDays`).
   */
  bucketMinutes: number;
  /** Bucket alignment: local midnight (on the hour, since NY's offset is in whole hours). */
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
      // Today + the previous 6 days, whole days.
      return { ...base, since: new Date(localMidnight(nowMs, 6)), granularity: "day" };
    case "30d":
      // Up to ~720 1h buckets: fits within PostgREST's 1000-row limit.
      return { ...base, since: new Date(localMidnight(nowMs, 29)), granularity: "day" };
    default:
      return { ...base, since: new Date(nowMs - 24 * 60 * 60 * 1000), granularity: "hour" };
  }
}

/** Sums 1h buckets per local day; each day keeps the instant of its first hour (local midnight). */
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
