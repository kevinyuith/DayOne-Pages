"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { OUTCOME_BADGE } from "@/components/dashboard/access-logs";
import { ChevronDownIcon, CloseIcon, EyeIcon, EyeOffIcon, FilterIcon, GlobeIcon, RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DEVICE_KEYS,
  OUTCOME_KEYS,
  RANGES,
  activeFilterCount,
  dashboardHref,
  type DashboardFilters,
  type RangeKey,
} from "@/lib/pages/dashboard-filters";

const btn =
  "inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-muted transition-colors hover:text-foreground hover:border-foreground/20";
const iconBtn =
  "inline-flex size-9 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:text-foreground hover:border-foreground/20";
const selectCls =
  "h-9 appearance-none rounded-lg border border-border bg-surface pr-9 text-sm font-medium text-foreground transition-colors hover:border-foreground/20";

/** Rótulo curto de cada período, no seletor segmentado (o nome longo vai no title). */
const RANGE_SHORT: Record<RangeKey, string> = { today: "Today", "24h": "24h", "7d": "7d", "30d": "30d" };

const DEVICE_LABEL: Record<string, string> = { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet" };

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

type DomainOption = { id: string; domain: string };
type CountryOption = { country: string; hits: number };

/**
 * A barra de controles do dashboard. Período, domínio e o popover "Filters"
 * mudam a URL (dashboardHref) e a página refaz as leituras no servidor; o
 * valor escolhido aparece na hora (useOptimistic) enquanto a navegação corre.
 * "Hide values" borra os números na tela (data-hide-values no <html>) e
 * "Refresh" recarrega os dados.
 */
export function DashboardControls({
  filters,
  domains,
  countries,
}: {
  filters: DashboardFilters;
  domains: DomainOption[];
  countries: CountryOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState(false);
  const [shown, setShown] = useOptimistic(filters);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-hide-values", hidden);
    return () => root.removeAttribute("data-hide-values");
  }, [hidden]);

  // Enquanto os dados novos chegam, o conteúdo fica esmaecido (ver globals.css) em vez de piscar.
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-dash-pending", pending);
    return () => root.removeAttribute("data-dash-pending");
  }, [pending]);

  const go = (next: DashboardFilters) =>
    start(() => {
      setShown(next);
      router.push(dashboardHref(next), { scroll: false });
    });

  const cleared = { ...shown, outcomes: [], devices: [], countries: [], hideBots: false };

  return (
    <div className="mb-6">
      <div className="relative flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
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
          <label className="relative min-w-0">
            <span className="sr-only">Filter by domain</span>
            <GlobeIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <select
              value={shown.domain ?? ""}
              onChange={(e) => go({ ...shown, domain: e.target.value || null })}
              className={`${selectCls} max-w-full pl-9`}
            >
              <option value="">All domains</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.domain}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FiltersPopover value={shown} countries={countries} onApply={go} />
          <button
            type="button"
            aria-pressed={hidden}
            aria-label={hidden ? "Show values" : "Hide values"}
            title={hidden ? "Show values" : "Hide values"}
            onClick={() => setHidden((v) => !v)}
            className={`${iconBtn} ${hidden ? "border-accent/40 text-accent" : ""}`}
          >
            {hidden ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
          </button>
          <button
            type="button"
            aria-label="Refresh"
            title="Refresh"
            disabled={pending}
            onClick={() => start(() => router.refresh())}
            className={`${iconBtn} disabled:opacity-60`}
          >
            <RefreshIcon className={`size-4 ${pending ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {activeFilterCount(shown) > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {shown.outcomes.length ? (
            <ActiveChip
              label={`Result: ${shown.outcomes.map((o) => OUTCOME_BADGE[o]?.label ?? o).join(", ")}`}
              onRemove={() => go({ ...shown, outcomes: [] })}
            />
          ) : null}
          {shown.devices.length ? (
            <ActiveChip
              label={`Device: ${shown.devices.map((d) => DEVICE_LABEL[d] ?? d).join(", ")}`}
              onRemove={() => go({ ...shown, devices: [] })}
            />
          ) : null}
          {shown.countries.length ? (
            <ActiveChip label={`Country: ${shown.countries.join(", ")}`} onRemove={() => go({ ...shown, countries: [] })} />
          ) : null}
          {shown.hideBots ? <ActiveChip label="Bots hidden" onRemove={() => go({ ...shown, hideBots: false })} /> : null}
          <button type="button" onClick={() => go(cleared)} className="font-medium text-muted underline-offset-2 hover:text-foreground hover:underline">
            Clear all
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ActiveChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 py-1 pl-2.5 pr-1 font-medium text-accent">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter ${label}`} className="rounded p-0.5 hover:bg-accent/15">
        <CloseIcon className="size-3.5" />
      </button>
    </span>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        pressed ? "border-accent/50 bg-accent/10 text-accent" : "border-border text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * O popover "Filters": resultado, dispositivo, país e esconder bots. Edita um
 * rascunho e só navega no "Apply" (marcar três países não vira três requests).
 * Posicionado pela barra (relative), alinhado à direita dela.
 */
function FiltersPopover({
  value,
  countries,
  onApply,
}: {
  value: DashboardFilters;
  countries: CountryOption[];
  onApply: (next: DashboardFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Um país escolhido que não aparece no período atual continua na lista (com 0), para dar para desmarcar.
  const countryOptions = [
    ...countries,
    ...draft.countries.filter((c) => !countries.some((o) => o.country === c)).map((c) => ({ country: c, hits: 0 })),
  ];

  return (
    <div ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (!open) setDraft(value);
          setOpen(!open);
        }}
        className={`${btn} ${count > 0 || open ? "border-accent/40 text-accent" : ""}`}
      >
        <FilterIcon className="size-4" />
        Filters
        {count > 0 ? (
          <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-[18px] text-accent-foreground">{count}</span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Filters"
          className="absolute right-0 top-full z-30 mt-2 w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-xl"
        >
          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Result</legend>
            <div className="flex flex-wrap gap-1.5">
              {OUTCOME_KEYS.map((o) => (
                <Chip key={o} pressed={draft.outcomes.includes(o)} onClick={() => setDraft({ ...draft, outcomes: toggle(draft.outcomes, o) })}>
                  {OUTCOME_BADGE[o]?.label ?? o}
                </Chip>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-4">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Device</legend>
            <div className="flex flex-wrap gap-1.5">
              {DEVICE_KEYS.map((d) => (
                <Chip key={d} pressed={draft.devices.includes(d)} onClick={() => setDraft({ ...draft, devices: toggle(draft.devices, d) })}>
                  {DEVICE_LABEL[d]}
                </Chip>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-4">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Country</legend>
            {countryOptions.length === 0 ? (
              <p className="text-xs text-muted">No country data in this period.</p>
            ) : (
              <div className="max-h-44 overflow-y-auto rounded-lg border border-border">
                {countryOptions.map((c) => (
                  <label
                    key={c.country}
                    className="flex cursor-pointer items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-sm last:border-0 hover:bg-foreground/5"
                  >
                    <Checkbox
                      checked={draft.countries.includes(c.country)}
                      onChange={() => setDraft({ ...draft, countries: toggle(draft.countries, c.country) })}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {countryName(c.country)} <span className="text-muted">({c.country})</span>
                    </span>
                    <span className="sensitive tabular-nums text-xs text-muted">{c.hits}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={draft.hideBots} onChange={(e) => setDraft({ ...draft, hideBots: e.target.checked })} />
            Hide bots
          </label>

          <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, outcomes: [], devices: [], countries: [], hideBots: false })}>
              Clear
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                // Período e domínio vêm do valor atual, não do rascunho: o popover só mexe nos seus grupos.
                onApply({ ...value, outcomes: draft.outcomes, devices: draft.devices, countries: draft.countries, hideBots: draft.hideBots });
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
