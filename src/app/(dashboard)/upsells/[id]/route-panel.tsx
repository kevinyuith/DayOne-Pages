"use client";

import { useState } from "react";
import { INPUT_CLASS } from "@/components/ui/field";
import type { UpsellRevenue, UpsellServed } from "@/lib/pages/upsell";
import { DEFAULT_FRONT_PARAM, ROUTE_NAME_MAX, STEP_LABELS, UPSELL_STEPS, fallbackGroup, parseFronts, type UpsellConfig, type UpsellRoute } from "@/lib/pages/upsell-types";
import { fmtInt, revenue, routeRevenue, visits } from "./metrics";
import { PerVisitText, RevenueText } from "./revenue-text";

/**
 * A route of the funnel (what the buyers bought at the front), or a new one:
 * its name and fronts are set here once and apply to every upsell step. The
 * fields are committed on Save, so a route never passes through another
 * route's fronts while being typed. Below, the route at each step.
 */
export function RoutePanel({
  config,
  route,
  served,
  revenueRows,
  onSave,
  onRemove,
  onCancel,
  onOpen,
}: {
  config: UpsellConfig;
  /** null = a new route. */
  route: UpsellRoute | null;
  served: UpsellServed[];
  revenueRows: UpsellRevenue[];
  /** Applies the name and fronts (to every step); an error message, or null. */
  onSave: (name: string, fronts: string[]) => string | null;
  onRemove: () => string | null;
  onCancel: () => void;
  /** Opens the route's group at a step. */
  onOpen: (step: string, group: string) => void;
}) {
  const [name, setName] = useState(route?.name ?? "");
  const [fronts, setFronts] = useState(route?.fronts.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const param = config.front_param ?? DEFAULT_FRONT_PARAM;
  const changed = !route || name.trim() !== route.name || fronts.trim() !== route.fronts.join(", ");

  const save = () => {
    const parsed = parseFronts(fronts);
    if ("error" in parsed) return setError(parsed.error);
    setError(onSave(name, parsed.fronts));
  };
  const money = route ? routeRevenue(route, served, revenueRows) : null;
  const steps = UPSELL_STEPS.map((id) => config.steps.find((s) => s.id === id)).filter((s) => s !== undefined);

  return (
    <section aria-label={route ? `Route ${route.name}` : "New route"} className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <h2 className="mr-2 text-lg font-semibold">{route ? "Route" : "New route"}</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Name</span>
          <input value={name} maxLength={ROUTE_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="6 bottles" className={`${INPUT_CLASS} w-48`} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Came with</span>
          <span className="flex items-center gap-1">
            <span className="whitespace-nowrap font-mono text-sm text-muted">?{param}=</span>
            <input value={fronts} onChange={(e) => setFronts(e.target.value)} placeholder="any other" className={`${INPUT_CLASS} w-36 font-mono`} />
          </span>
        </label>
        <button type="submit" disabled={!changed} className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-40">
          {route ? "Save" : "Add route"}
        </button>
        <button type="button" onClick={onCancel} className="min-h-10 px-2 text-sm font-semibold text-muted hover:text-foreground">
          {route ? "Close" : "Cancel"}
        </button>
        {route ? (
          <button type="button" onClick={() => setError(onRemove())} className="ml-auto min-h-10 px-1 text-sm font-semibold text-red-600 dark:text-red-400">
            Remove route
          </button>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {route ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[8rem_minmax(0,1fr)_6rem_6rem] border-b border-border bg-foreground/[0.03] px-3 py-2 text-xs font-semibold text-foreground/80">
            <span>Step</span>
            <span>At this step</span>
            <span className="text-right">Visits</span>
            <span className="text-right">Revenue</span>
          </div>
          {steps.map((s) => {
            const gid = route.groups[s.id];
            const fb = fallbackGroup(s);
            return (
              <div key={s.id} className="grid grid-cols-[8rem_minmax(0,1fr)_6rem_6rem] items-center border-b border-border/60 px-3 py-2 text-sm last:border-b-0">
                <span className="text-muted">{STEP_LABELS[s.id]}</span>
                <span>
                  {gid ? (
                    <button type="button" onClick={() => onOpen(s.id, gid)} className="min-h-8 font-semibold text-accent">
                      Open its setup
                    </button>
                  ) : (
                    <span className="text-muted">Gets {fb?.name ?? "—"}</span>
                  )}
                </span>
                <span className="text-right tabular-nums">{gid ? fmtInt(visits(served, { step: s.id, grp: gid })) : "—"}</span>
                <span className="text-right tabular-nums">{gid ? <Sold money={revenue(revenueRows, { step: s.id, grp: gid })} /> : "—"}</span>
              </div>
            );
          })}
          {money ? (
            <div className="flex justify-end gap-2 bg-foreground/[0.03] px-3 py-2 text-sm">
              <span className="text-muted">Revenue per buyer</span>
              <b className="tabular-nums">
                <PerVisitText exact={money.revenue} estimated={money.estimated} visits={money.buyers} />
              </b>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Sold({ money }: { money: { revenue: number; estimated: number } }) {
  return <RevenueText exact={money.revenue} estimated={money.estimated} />;
}
