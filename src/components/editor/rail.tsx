"use client";

import type { ReactNode } from "react";
import { GridIcon, LayersIcon, LinkIcon, PagesIcon, RouteIcon } from "@/components/icons";

/**
 * The icon bar on the left of the editor (as in the reference builder):
 * each icon opens a panel beside it; clicking the active one collapses the panel.
 */
export type RailPanel = "pages" | "funnel" | "widgets" | "layers" | "links";

const ITEMS: { key: RailPanel; label: string; icon: ReactNode }[] = [
  { key: "pages", label: "Pages", icon: <PagesIcon className="size-5" /> },
  { key: "funnel", label: "Funnel", icon: <RouteIcon className="size-5" /> },
  { key: "widgets", label: "Widgets", icon: <GridIcon className="size-5" /> },
  { key: "layers", label: "Layers", icon: <LayersIcon className="size-5" /> },
  { key: "links", label: "Links", icon: <LinkIcon className="size-5" /> },
];

export function Rail({
  active,
  onSelect,
  badges,
  panels,
}: {
  active: RailPanel | null;
  onSelect: (p: RailPanel) => void;
  /** Per-panel counters (e.g. how many links the page has). */
  badges?: Partial<Record<RailPanel, number>>;
  /** Which panels to show (in ITEMS order). Default: all. A funnel page has a single slug, so it drops "pages". */
  panels?: readonly RailPanel[];
}) {
  const items = panels ? ITEMS.filter((it) => panels.includes(it.key)) : ITEMS;
  return (
    <nav className="flex w-16 shrink-0 flex-col items-stretch gap-1 rounded-xl border border-border bg-surface p-1.5" aria-label="Editor panels">
      {items.map((it) => {
        const isActive = active === it.key;
        const badge = badges?.[it.key];
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            aria-pressed={isActive}
            title={it.label}
            className={`relative flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium transition-colors ${
              isActive ? "bg-accent/10 text-accent" : "text-muted hover:bg-foreground/5 hover:text-foreground"
            }`}
          >
            {it.icon}
            <span>{it.label}</span>
            {badge ? (
              <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-4 text-accent-foreground">
                {badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
