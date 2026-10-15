"use client";

import { Fragment, type CSSProperties } from "react";
import type { UpsellRevenue, UpsellServed } from "@/lib/pages/upsell";
import { DEFAULT_FRONT_PARAM, STEP_LABELS, UPSELL_STEPS, fallbackGroup, type UpsellConfig, type UpsellRoute, type UpsellStep } from "@/lib/pages/upsell-types";
import { stepPaths } from "@/lib/pages/vendor-paths";
import { fmtInt, fmtPct, revenue, routeRevenue, visits } from "./metrics";
import { PerVisitText, RevenueText } from "./revenue-text";

/** What the panel under the pipeline shows: a route's cell at a step (the Thank you page: no group), or a route itself (null = a new one). */
export type Selection = { kind: "cell"; step: string; group: string | null } | { kind: "route"; key: string | null };

/**
 * The funnel as lanes: one row per ROUTE (what the buyers bought at the front,
 * set once at the Checkout) across every upsell step, and the Thank you page.
 * A cell is the route's group at that step; a step where the route has none
 * gives its buyers the step's fallback group. The headers carry the period's
 * visits of each step and its share of the previous one's.
 */
export function Pipeline({
  config,
  routes,
  selected,
  onSelect,
  served,
  revenueRows,
  checkout,
  onAddUpsell,
  onAddThankYou,
  onRouteToStep,
  folder,
}: {
  config: UpsellConfig;
  /** The vendor page's folder ("/bg", or ""): each step's header lists its paths (/up1 · /bg/up1 · its aliases). */
  folder: string;
  routes: UpsellRoute[];
  selected: Selection;
  onSelect: (s: Selection) => void;
  served: UpsellServed[];
  revenueRows: UpsellRevenue[];
  checkout: Record<string, string>;
  onAddUpsell: (() => void) | null;
  onAddThankYou: (() => void) | null;
  /** Gives a route its own group at a step where it gets the fallback. */
  onRouteToStep: (route: UpsellRoute, step: UpsellStep) => void;
}) {
  const upsells = UPSELL_STEPS.map((id) => config.steps.find((s) => s.id === id)).filter((s) => s !== undefined);
  const ty = config.steps.find((s) => s.id === "ty");
  // Each step's visits and its share of the previous step's (the first one: just the visits).
  const order = [...upsells.map((s) => s.id as string), ...(ty ? ["ty"] : [])];
  const labels = new Map(
    order.map((id, i) => {
      const v = visits(served, { step: id });
      const before = i > 0 ? visits(served, { step: order[i - 1] }) : null;
      return [id, before === null ? `${fmtInt(v)} visits` : `${fmtInt(v)} visits · ${fmtPct(v, before)}`] as const;
    }),
  );

  // Columns: routes · each upsell step · "+ Add upsell" · Thank you. Rows: header · one per route · "+ Route".
  const addCol = onAddUpsell ? upsells.length + 2 : null;
  const tyCol = (addCol ?? upsells.length + 1) + 1;
  const lanes = Math.max(routes.length, 1);
  const columns = ["10rem", ...upsells.map(() => "14rem"), ...(onAddUpsell ? ["8rem"] : []), ...(ty || onAddThankYou ? ["9rem"] : [])].join(" ");
  const at = (col: number, row: number, span = 1): CSSProperties => ({ gridColumn: col, gridRow: span > 1 ? `${row} / span ${span}` : row });
  const head = "flex flex-col justify-end gap-0.5 pb-1 text-xs font-semibold uppercase tracking-wider text-muted";

  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-max gap-2" style={{ gridTemplateColumns: columns }}>
        <div className={head} style={at(1, 1)}>
          <span>Checkout</span>
          <span className="font-mono normal-case tracking-normal">?{config.front_param ?? DEFAULT_FRONT_PARAM}=</span>
        </div>
        {upsells.map((s, i) => (
          <div key={s.id} className={head} style={at(i + 2, 1)}>
            <span className="flex items-baseline justify-between gap-2">
              <span className="shrink-0">{STEP_LABELS[s.id]}</span>
              <span className="truncate font-mono normal-case tracking-normal" title={stepPaths(s.slug, folder, s.aliases).join(" · ")}>
                {stepPaths(s.slug, folder, s.aliases).join(" · ")}
              </span>
            </span>
            <span className="normal-case tracking-normal text-accent">{labels.get(s.id)}</span>
          </div>
        ))}
        {ty || onAddThankYou ? (
          <div className={head} style={at(tyCol, 1)}>
            <span>{STEP_LABELS.ty}</span>
            {ty ? <span className="normal-case tracking-normal text-accent">{labels.get("ty")}</span> : null}
          </div>
        ) : null}

        {routes.map((r, row) => {
          const active = selected.kind === "route" && selected.key === r.key;
          const money = routeRevenue(r, served, revenueRows);
          return (
            <Fragment key={r.key}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect({ kind: "route", key: r.key })}
                style={at(1, row + 2)}
                className={`flex flex-col gap-1 rounded-xl border border-dashed bg-foreground/5 p-3 text-left text-sm ${active ? "border-2 border-accent" : "border-foreground/30 hover:border-foreground/50"}`}
              >
                <b className="font-semibold">{r.name}</b>
                <span className="font-mono text-xs text-muted">{r.fronts.length ? r.fronts.join(", ") : "any other front"}</span>
                {money.buyers > 0 ? (
                  <span className="flex items-baseline gap-1 text-xs">
                    <b className="font-semibold">
                      <PerVisitText exact={money.revenue} estimated={money.estimated} visits={money.buyers} />
                    </b>
                    <span className="text-muted">/ buyer</span>
                  </span>
                ) : null}
              </button>
              {upsells.map((s, i) => {
                const gid = r.groups[s.id];
                const g = gid ? s.groups?.find((x) => x.id === gid) : undefined;
                if (!g) {
                  const fb = fallbackGroup(s);
                  return (
                    <div key={s.id} style={at(i + 2, row + 2)} className="flex flex-col items-start justify-center gap-1 rounded-xl border border-dashed border-border p-3 text-xs text-muted">
                      <span>Gets {fb?.name ?? "—"}</span>
                      <button type="button" onClick={() => onRouteToStep(r, s)} className="min-h-8 font-semibold text-accent">
                        + Own setup
                      </button>
                    </div>
                  );
                }
                const cellActive = selected.kind === "cell" && selected.step === s.id && selected.group === g.id;
                const offer = g.offers?.[0];
                const sold = revenue(revenueRows, { step: s.id, grp: g.id });
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={cellActive}
                    onClick={() => onSelect({ kind: "cell", step: s.id, group: g.id })}
                    style={at(i + 2, row + 2)}
                    className={`flex flex-col gap-1 rounded-xl border bg-surface p-3 text-left text-sm transition-shadow ${cellActive ? "border-2 border-accent shadow-md" : "border-border hover:border-foreground/30"}`}
                  >
                    <span className="flex items-baseline justify-between gap-2 text-xs text-muted">
                      <span>{fmtInt(visits(served, { step: s.id, grp: g.id }))} visits</span>
                      {sold.revenue > 0 || sold.estimated > 0 ? (
                        <b className="text-right font-semibold text-foreground">
                          <RevenueText exact={sold.revenue} estimated={sold.estimated} />
                        </b>
                      ) : null}
                    </span>
                    <span className="text-xs">
                      CTA{" "}
                      {offer ? (
                        <span className="font-mono">
                          {offer.offer}
                          {checkout[offer.offer] ? "" : " (no value)"}
                          {(g.offers?.length ?? 0) > 1 ? ` +${(g.offers?.length ?? 1) - 1}` : ""}
                        </span>
                      ) : (
                        <span className="text-muted">none</span>
                      )}
                    </span>
                    {(g.downsells?.length ?? 0) > 0 ? (
                      <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">leave/back → {g.downsells?.length} downsell{g.downsells?.length === 1 ? "" : "s"}, same page</span>
                    ) : null}
                  </button>
                );
              })}
            </Fragment>
          );
        })}

        {onAddUpsell && addCol ? (
          <button
            type="button"
            onClick={onAddUpsell}
            style={at(addCol, 2, lanes)}
            className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-foreground/25 text-sm font-semibold text-muted hover:border-foreground/40 hover:text-foreground"
          >
            <span>+ Add upsell</span>
            <span className="text-xs font-medium">{STEP_LABELS[UPSELL_STEPS[upsells.length] ?? "up5"]}</span>
          </button>
        ) : null}

        {ty ? (
          <button
            type="button"
            aria-pressed={selected.kind === "cell" && selected.step === "ty"}
            onClick={() => onSelect({ kind: "cell", step: "ty", group: null })}
            style={at(tyCol, 2, lanes)}
            className={`flex flex-col justify-center gap-1 rounded-xl bg-foreground p-3 text-left text-sm text-background ${selected.kind === "cell" && selected.step === "ty" ? "ring-2 ring-accent ring-offset-2" : ""}`}
          >
            <b>Thank you</b>
            <span className="font-mono text-xs opacity-80">{stepPaths(ty.slug, folder, ty.aliases).join(" · ")}</span>
          </button>
        ) : onAddThankYou ? (
          <button
            type="button"
            onClick={onAddThankYou}
            style={at(tyCol, 2, lanes)}
            className="min-h-16 rounded-xl border-2 border-dashed border-foreground/25 text-sm font-semibold text-muted"
          >
            + Thank you
          </button>
        ) : null}

        {upsells.length > 0 ? (
          <button
            type="button"
            aria-pressed={selected.kind === "route" && selected.key === null}
            onClick={() => onSelect({ kind: "route", key: null })}
            style={at(1, lanes + 2)}
            className={`min-h-11 rounded-xl border-2 border-dashed text-sm font-semibold ${selected.kind === "route" && selected.key === null ? "border-accent text-accent" : "border-foreground/25 text-muted hover:border-foreground/40 hover:text-foreground"}`}
          >
            + Route
          </button>
        ) : null}
      </div>
    </div>
  );
}
