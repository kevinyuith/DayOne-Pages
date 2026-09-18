"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { CalendarIcon, ChevronDownIcon, EyeOffIcon, FilterIcon, RefreshIcon } from "@/components/icons";

const btn =
  "inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-foreground hover:border-foreground/20";

/**
 * A barra de controles do dashboard. Data e "All domains" são visuais (o
 * layout ainda não filtra por período/domínio). "Hide values" e "Refresh"
 * funcionam de verdade: um borra os números na tela (data-hide-values no
 * <html>), o outro recarrega os dados do servidor.
 */
export function DashboardControls({ dateLabel, domains }: { dateLabel: string; domains: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-hide-values", hidden);
    return () => root.removeAttribute("data-hide-values");
  }, [hidden]);

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${btn} cursor-default hover:border-border hover:text-muted`}>
          <CalendarIcon className="size-4" />
          {dateLabel}
        </span>
        <label className="relative">
          <span className="sr-only">Filter by domain</span>
          <select
            defaultValue=""
            className="appearance-none rounded-lg border border-border bg-surface py-2 pl-3 pr-9 text-sm font-medium text-muted transition-colors hover:text-foreground"
          >
            <option value="">All domains</option>
            {domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn}>
          <FilterIcon className="size-4" />
          Filters
        </button>
        <button
          type="button"
          aria-pressed={hidden}
          onClick={() => setHidden((v) => !v)}
          className={`${btn} ${hidden ? "border-accent/40 text-accent" : ""}`}
        >
          <EyeOffIcon className="size-4" />
          {hidden ? "Show values" : "Hide values"}
        </button>
        <button type="button" disabled={pending} onClick={() => start(() => router.refresh())} className={`${btn} disabled:opacity-60`}>
          <RefreshIcon className={`size-4 ${pending ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
    </div>
  );
}
