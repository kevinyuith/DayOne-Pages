"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronRightIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import type { FunnelVslRow, VslStatus } from "@/lib/pages/queries";
import { FunnelFilterBar, NO_FUNNEL_FILTERS, funnelFilterOptions, funnelMatches } from "./funnel-filters";

/**
 * The Funnel screen's VSLs tab: one dayone-main funnel per row, collapsed;
 * open, the VSLs linked to it in the VSL pipeline (public.vsl.funnel_ids).
 * Read-only: the VSLs are managed in dayone-main.
 */

const STATUS_LABELS: Record<VslStatus, string> = {
  VALIDATED: "Validated",
  VALIDATION: "Validation",
  STAND_BY: "Stand by",
  PAUSED: "Paused",
  DISCARDED: "Discarded",
};
const STATUS_TONE: Record<VslStatus, "success" | "warning" | "neutral" | "danger" | "info"> = {
  VALIDATED: "success",
  VALIDATION: "info",
  STAND_BY: "neutral",
  PAUSED: "warning",
  DISCARDED: "danger",
};

/** Seconds as m:ss. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const GRID = "grid grid-cols-[1.5rem_3.5rem_minmax(12rem,1fr)_8rem_4rem_5rem_6rem_5rem] items-center gap-3";

export function VslList({ rows, initialOpen }: { rows: FunnelVslRow[]; initialOpen: string | null }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialOpen ? [initialOpen] : []));
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(NO_FUNNEL_FILTERS);
  const options = useMemo(() => funnelFilterOptions(rows.map((r) => r.funnel)), [rows]);

  const shown = useMemo(
    () =>
      rows
        .filter((r) => funnelMatches(r.funnel, filters, query, r.vsls.map((v) => v.title)))
        // Most VSLs first; ties by name, then by code (F1, F2…).
        .sort(
          (a, b) =>
            b.vsls.length - a.vsls.length ||
            a.funnel.name.localeCompare(b.funnel.name) ||
            a.funnel.code.localeCompare(b.funnel.code, undefined, { numeric: true }),
        ),
    [rows, query, filters],
  );
  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allOpen = shown.length > 0 && shown.every((r) => open.has(r.funnel.id));

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FunnelFilterBar query={query} onQuery={setQuery} filters={filters} onFilters={setFilters} options={options} shown={shown.length} total={rows.length} />
        <button
          type="button"
          onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map((r) => r.funnel.id)))}
          className="h-8 self-start rounded-md border border-border px-2.5 text-xs text-muted hover:text-foreground lg:self-auto"
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <div className="min-w-[56rem]">
          <div className={`${GRID} border-b border-border px-4 py-2.5 text-xs font-medium text-muted`}>
            <span />
            <span>Code</span>
            <span>Name</span>
            <span>Platform</span>
            <span>Niche</span>
            <span>Region</span>
            <span>Status</span>
            <span className="text-right">VSLs</span>
          </div>

          {shown.map((r) => {
            const f = r.funnel;
            const isOpen = open.has(f.id);
            return (
              <Fragment key={f.id}>
                <button
                  type="button"
                  onClick={() => toggle(f.id)}
                  aria-expanded={isOpen}
                  className={`${GRID} w-full border-b border-border px-4 py-3 text-left text-sm transition-colors hover:bg-foreground/[0.03] ${isOpen ? "bg-foreground/[0.03]" : ""}`}
                >
                  <ChevronRightIcon className={`size-4 text-muted transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  <span className="w-fit rounded-md bg-foreground/10 px-1.5 py-0.5 font-mono text-xs font-semibold">{f.code}</span>
                  <span className="truncate font-medium">{f.name}</span>
                  <span className="truncate text-muted">{f.platform ?? ""}</span>
                  <span className="text-muted">{f.niche ?? ""}</span>
                  <span className="text-muted">{f.region ?? ""}</span>
                  <span>{f.status ? <Badge tone={f.status === "ACTIVE" ? "success" : f.status === "PAUSED" ? "warning" : "neutral"}>{f.status.toLowerCase()}</Badge> : null}</span>
                  <span className="text-right tabular-nums">{r.vsls.length || "—"}</span>
                </button>

                {isOpen ? (
                  <div className="border-b border-border bg-foreground/[0.02] px-4 py-3">
                    {r.vsls.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted">No VSLs linked to this funnel.</p>
                    ) : (
                      <div className="overflow-hidden rounded-lg border border-border bg-surface">
                        <table className="w-full text-sm">
                          <thead className="border-b border-border text-left text-xs text-muted">
                            <tr>
                              <th className="px-3 py-2 font-medium">VSL</th>
                              <th className="px-3 py-2 font-medium">Status</th>
                              <th className="px-3 py-2 font-medium">Language</th>
                              <th className="px-3 py-2 text-right font-medium">Pitch</th>
                              <th className="px-3 py-2 font-medium">Copy</th>
                              <th className="px-3 py-2 font-medium">Editor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.vsls.map((v) => (
                              <tr key={v.id} className="border-b border-border last:border-0">
                                <td className="px-3 py-2">
                                  {v.videoUrl ? (
                                    <a href={v.videoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium hover:text-accent" title="Play the video">
                                      <span aria-hidden className="text-xs text-accent">
                                        ▶
                                      </span>
                                      {v.title}
                                    </a>
                                  ) : (
                                    <span className="font-medium">{v.title}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">{v.status ? <Badge tone={STATUS_TONE[v.status]}>{STATUS_LABELS[v.status]}</Badge> : <span className="text-muted">—</span>}</td>
                                <td className="px-3 py-2 text-muted">{v.language ?? "—"}</td>
                                <td className="px-3 py-2 text-right tabular-nums text-muted">{v.pitch ? clock(v.pitch) : "—"}</td>
                                <td className="px-3 py-2 text-muted">{v.copywriter ?? "—"}</td>
                                <td className="px-3 py-2 text-muted">{v.editor ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          {shown.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No funnel matches the search and filters.</p> : null}
        </div>
      </div>
    </div>
  );
}
