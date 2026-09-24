"use client";

import { SearchIcon } from "@/components/icons";
import { INPUT_CLASS, SELECT_BASE } from "@/components/ui/field";
import type { MainFunnel } from "@/lib/pages/queries";

/**
 * The search and filters of the Funnel screen, shared by its tabs (Pages and
 * VSLs): a search box plus one select per dayone-main funnel field.
 */

/** The list filters: fields of the dayone-main funnel ("" = all). */
export const FUNNEL_FILTERS = [
  { key: "platform", all: "All platforms" },
  { key: "niche", all: "All niches" },
  { key: "region", all: "All regions" },
  { key: "status", all: "All statuses" },
] as const;
export type FunnelFilterKey = (typeof FUNNEL_FILTERS)[number]["key"];
export type FunnelFilters = Record<FunnelFilterKey, string>;
export const NO_FUNNEL_FILTERS: FunnelFilters = { platform: "", niche: "", region: "", status: "" };

/** Each filter's options: the values the funnels have, in alphabetical order. */
export function funnelFilterOptions(funnels: (MainFunnel | null)[]): Record<FunnelFilterKey, string[]> {
  const out = {} as Record<FunnelFilterKey, string[]>;
  for (const { key } of FUNNEL_FILTERS) out[key] = [...new Set(funnels.map((f) => f?.[key] ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return out;
}

export const isFiltering = (filters: FunnelFilters) => FUNNEL_FILTERS.some(({ key }) => filters[key] !== "");

/**
 * Whether a funnel passes the filters and the search. `extra` is more text to
 * search in (the names of its pages or VSLs). With a filter, a row without a
 * funnel drops out (it has no platform, niche…).
 */
export function funnelMatches(f: MainFunnel | null, filters: FunnelFilters, query: string, extra: string[]): boolean {
  if (FUNNEL_FILTERS.some(({ key }) => filters[key] !== "" && (f?.[key] ?? "") !== filters[key])) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = f ? [f.code, f.name, f.platform, f.niche, f.region, f.status] : ["unlinked"];
  return [...hay, ...extra].some((v) => (v ?? "").toLowerCase().includes(q));
}

export function FunnelFilterBar({
  query,
  onQuery,
  filters,
  onFilters,
  options,
  shown,
  total,
}: {
  query: string;
  onQuery: (q: string) => void;
  filters: FunnelFilters;
  onFilters: (f: FunnelFilters) => void;
  options: Record<FunnelFilterKey, string[]>;
  /** How many funnels are shown, and how many there are. */
  shown: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative w-full sm:w-64">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search F-code or name…" aria-label="Search" className={`${INPUT_CLASS} pl-8`} />
      </label>
      {FUNNEL_FILTERS.map(({ key, all }) => (
        <select
          key={key}
          value={filters[key]}
          onChange={(e) => onFilters({ ...filters, [key]: e.target.value })}
          aria-label={all.replace("All ", "Filter by ")}
          className={`${SELECT_BASE} h-9 w-auto text-sm ${filters[key] ? "border-accent/50 text-accent" : ""}`}
        >
          <option value="">{all}</option>
          {options[key].map((v) => (
            <option key={v} value={v}>
              {key === "status" ? v.toLowerCase() : v}
            </option>
          ))}
        </select>
      ))}
      {isFiltering(filters) ? (
        <button type="button" onClick={() => onFilters(NO_FUNNEL_FILTERS)} className="text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline">
          Clear filters
        </button>
      ) : null}
      <span className="text-xs text-muted">
        {shown} of {total} funnels
      </span>
    </div>
  );
}
