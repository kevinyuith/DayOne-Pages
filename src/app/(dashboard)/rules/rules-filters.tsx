"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useTransition } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { RANGES, RANGE_SHORT, type RangeKey } from "@/lib/pages/dashboard-filters";
import { rulesHref } from "./rules-href";

type Value = { range: RangeKey; flow: string | null };

/**
 * The Rules screen's bar: the period of the Blocked numbers (?range=, the
 * Dashboard's periods) and the Flow filter (?flow=, the rules' tags; "All
 * flows" clears it). Both navigate and page.tsx reads them on the server; the
 * choice shows right away (useOptimistic) and the table is dimmed while the new
 * numbers come (data-dash-pending, as on the Dashboard).
 */
export function RulesFilters({ range, flow, flows }: Value & { flows: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic<Value>({ range, flow });

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-dash-pending", pending);
    return () => root.removeAttribute("data-dash-pending");
  }, [pending]);

  const go = (next: Value) =>
    start(() => {
      setShown(next);
      router.push(rulesHref(next.range, next.flow), { scroll: false });
    });

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div role="group" aria-label="Period" className="inline-flex h-9 items-center rounded-lg border border-border bg-surface p-0.5">
        {RANGES.map((r) => {
          const active = shown.range === r.key;
          return (
            <button
              key={r.key}
              type="button"
              aria-pressed={active}
              title={r.label}
              onClick={() => !active && go({ ...shown, range: r.key })}
              className={`h-full rounded-md px-3 text-sm font-medium transition-colors ${
                active ? "bg-foreground/[0.08] text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {RANGE_SHORT[r.key]}
            </button>
          );
        })}
      </div>
      <label className="relative inline-flex items-center">
        <span className="sr-only">Flow</span>
        <select
          value={shown.flow ?? ""}
          onChange={(e) => go({ ...shown, flow: e.target.value || null })}
          className={`appearance-none rounded-lg border border-border bg-surface py-2 pl-3 pr-9 text-sm font-medium transition-colors hover:text-foreground ${shown.flow ? "text-foreground" : "text-muted"}`}
        >
          <option value="">All flows</option>
          {flows.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
      </label>
    </div>
  );
}
