"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { PlatformTile, platformMeta } from "@/components/platform-chip";
import { RANGES, RANGE_SHORT, type RangeKey } from "@/lib/pages/dashboard-filters";
import { rulesHref, type StageFilter } from "./rules-href";

type Value = { range: RangeKey; platform: string | null; q: string; stage: StageFilter };

/**
 * The Rules screen's bar: the period of the Blocked numbers (?range=), a text
 * search by name/reason (?q=), the stage (?stage=, Bot or Suspicious) and the
 * Platform filter (?platform=). Each navigates and page.tsx reads them on the
 * server; the choice shows right away (useOptimistic) and the table is dimmed
 * while the new numbers come (data-dash-pending, as on the Dashboard). The search debounces.
 */
export function RulesFilters({ range, platform, platforms, q, stage }: Value & { platforms: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic<Value>({ range, platform, q, stage });
  const [text, setText] = useState(q);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-dash-pending", pending);
    return () => root.removeAttribute("data-dash-pending");
  }, [pending]);

  const go = (partial: Partial<Value>) => {
    const next: Value = { range: shown.range, platform: shown.platform, stage: shown.stage, q: text, ...partial };
    start(() => {
      setShown(next);
      router.push(rulesHref(next.range, next.platform, next.q, next.stage), { scroll: false });
    });
  };

  // Debounce the search box into the URL.
  useEffect(() => {
    if (text === shown.q) return;
    const t = setTimeout(() => go({ q: text }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const selectCls = (on: boolean) =>
    `appearance-none rounded-lg border border-border bg-surface py-2 pl-3 pr-9 text-sm font-medium transition-colors hover:text-foreground ${on ? "text-foreground" : "text-muted"}`;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Period" className="inline-flex h-9 items-center rounded-lg border border-border bg-surface p-0.5">
        {RANGES.map((r) => {
          const active = shown.range === r.key;
          return (
            <button
              key={r.key}
              type="button"
              aria-pressed={active}
              title={r.label}
              onClick={() => !active && go({ range: r.key })}
              className={`h-full rounded-md px-3 text-sm font-medium transition-colors ${
                active ? "bg-foreground/[0.08] text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {RANGE_SHORT[r.key]}
            </button>
          );
        })}
      </div>

      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search rules…"
        aria-label="Search rules by name or reason"
        className="h-9 w-48 rounded-lg border border-border bg-surface px-3 text-sm transition-colors placeholder:text-muted"
      />

      <label className="relative inline-flex items-center">
        <span className="sr-only">Stage</span>
        <select value={shown.stage ?? ""} onChange={(e) => go({ stage: (e.target.value || null) as StageFilter })} className={selectCls(shown.stage !== null)}>
          <option value="">All stages</option>
          <option value="bot">Bot</option>
          <option value="suspicious">Suspicious</option>
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
      </label>

      <div role="group" aria-label="Platform" className="inline-flex h-9 flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-1.5">
        {platforms.map((p) => {
          const active = (shown.platform ?? "").toLowerCase() === p.toLowerCase();
          return (
            <button
              key={p}
              type="button"
              aria-pressed={active}
              title={platformMeta(p).label}
              onClick={() => go({ platform: active ? null : p })}
              className={`rounded-md p-1 transition-colors ${active ? "bg-foreground/[0.12]" : "opacity-60 hover:opacity-100"}`}
            >
              <span className="sr-only">{platformMeta(p).label}</span>
              <PlatformTile tag={p} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
