/**
 * Dashboard filters (`/`): period, domain, platform, outcome, device, country
 * and "hide bots". They live in the URL (?range=7d&domain=<id>&platform=facebook
 * &outcome=served,blocked&device=mobile&country=US,BR&bots=hide), which the page reads on the server; so
 * a filter survives a refresh and can be shared. No server dependency: the
 * control bar (client) uses the same module to build the URL.
 */

import { localMidnight } from "@/lib/time-zone";

export const RANGES = [
  { key: "today", label: "Today", short: "today" },
  { key: "24h", label: "Last 24 hours", short: "24h" },
  { key: "7d", label: "Last 7 days", short: "7d" },
  { key: "30d", label: "Last 30 days", short: "30d" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export const DEFAULT_RANGE: RangeKey = "24h";

/** Short label for each period, in the segmented selectors (the long name goes in the title). */
export const RANGE_SHORT: Record<RangeKey, string> = { today: "Today", "24h": "24h", "7d": "7d", "30d": "30d" };

/** The period in the URL (?range=); anything unknown is the default. */
export function parseRange(v: string | string[] | undefined): RangeKey {
  return RANGES.find((r) => r.key === v)?.key ?? DEFAULT_RANGE;
}

/** The outcomes you can filter by (those in pages.hits, minus the residual "other"). */
export const OUTCOME_KEYS = ["served", "redirect", "blocked", "bot", "notfound", "error"] as const;
export const DEVICE_KEYS = ["desktop", "mobile", "tablet"] as const;

export type DashboardFilters = {
  range: RangeKey;
  /** id in pages.domains, or null for all. */
  domain: string | null;
  /** The click's sub11, lowercased (pages.hits.platform), or null for all. */
  platform: string | null;
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
  const range = parseRange(sp.range);
  const domain = typeof sp.domain === "string" && domainIds.includes(sp.domain) ? sp.domain : null;
  const platform = typeof sp.platform === "string" ? sp.platform.trim().toLowerCase() : "";
  return {
    range,
    domain,
    platform: platform.length > 0 && platform.length <= 40 ? platform : null,
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
  if (f.platform) qs.set("platform", f.platform);
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

/** Some platforms' names, spelled their way; any other sub11 gets its first letter capitalized. */
const PLATFORM_NAMES: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube", newsbreak: "NewsBreak" };

export function platformLabel(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

// ── Period → time window ────────────────────────────────────────────────────

export type RangeWindow = {
  since: Date;
  granularity: "hour" | "day";
  label: string;
  short: string;
};

export function resolveRange(range: RangeKey, nowMs: number): RangeWindow {
  const midnight = localMidnight(nowMs);
  const r = RANGES.find((x) => x.key === range) ?? RANGES[1];
  const base = { label: r.label, short: r.short };
  switch (r.key) {
    case "today":
      return { ...base, since: new Date(midnight), granularity: "hour" };
    case "7d":
      // Today + the previous 6 days, whole days.
      return { ...base, since: new Date(localMidnight(nowMs, 6)), granularity: "day" };
    case "30d":
      return { ...base, since: new Date(localMidnight(nowMs, 29)), granularity: "day" };
    default:
      return { ...base, since: new Date(nowMs - 24 * 60 * 60 * 1000), granularity: "hour" };
  }
}

const HOUR_MS = 3600_000;

/**
 * The Traffic chart's bucket edges, as instants: every hour from the hour of
 * `since` to the one after now, or every New York midnight from `since` to the
 * one after today. The database counts distinct visitors between two edges and
 * knows no time zone; a NY day has 23, 24 or 25 hours, so the midnights come
 * from localMidnight, never from adding 24h. NY hours are UTC hours (the
 * offset is whole hours).
 */
export function bucketEdges(range: RangeWindow, nowMs: number): Date[] {
  if (range.granularity === "hour") {
    const first = Math.floor(range.since.getTime() / HOUR_MS) * HOUR_MS;
    const last = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
    const edges: Date[] = [];
    for (let t = first; t <= last; t += HOUR_MS) edges.push(new Date(t));
    return edges;
  }
  // Today's midnight back to the one of `since`, then tomorrow's: 36h after today's
  // midnight is tomorrow whatever DST does, and its midnight closes today.
  const midnights: number[] = [];
  for (let k = 0; ; k++) {
    const m = localMidnight(nowMs, k);
    if (m < range.since.getTime()) break;
    midnights.unshift(m);
  }
  midnights.push(localMidnight(localMidnight(nowMs) + 36 * HOUR_MS));
  return midnights.map((m) => new Date(m));
}
