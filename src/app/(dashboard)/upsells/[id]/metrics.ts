import type { UpsellAnswer, UpsellRevenue, UpsellServed } from "@/lib/pages/upsell";
import { DEFAULT_FLOW, UPSELL_STEPS, type UpsellRoute, type UpsellStepId } from "@/lib/pages/upsell-types";

/**
 * The editor's numbers, from the period's served responses (pages.hits.upsell,
 * pages.upsell_funnel_stats) and dot's answers (pages.upsell_funnel_answers).
 * Visits = served responses (200); accepted/declined = dot's events, one per
 * click and kind; revenue = the platform's sales tied to those accepts
 * (pages.upsell_funnel_revenue): EXACT when tied by the order (its vendor_purchase
 * in dot and the accept share the dotid), ESTIMATED when only by the same IP
 * within 6 h — shown apart ("+ $X estimated").
 */

type Filter = { step?: string; grp?: string; flow?: string; page?: string; offer?: string; video?: string };

export function visits(served: UpsellServed[], f: Filter): number {
  return served
    .filter((r) => (f.step === undefined || r.step === f.step) && (f.grp === undefined || r.grp === f.grp) && (f.flow === undefined || r.flow === f.flow)
      && (f.page === undefined || r.page === f.page) && (f.offer === undefined || r.offer === f.offer) && (f.video === undefined || r.video === f.video))
    .reduce((a, r) => a + r.hits, 0);
}

type AnswerFilter = { origin: string; kind: "accept" | "decline"; downsell?: boolean; grp?: string; flow?: string; page?: string; offer?: string };

export function answers(rows: UpsellAnswer[], f: AnswerFilter): number {
  const event = `${f.downsell ? "downsell" : "upsell"}_${f.kind}`;
  return rows
    .filter((r) => r.event === event && r.origin === f.origin && (f.grp === undefined || r.grp === f.grp) && (f.flow === undefined || r.flow === f.flow)
      && (f.page === undefined || r.page === f.page) && (f.offer === undefined || r.offer === f.offer))
    .reduce((a, r) => a + r.n, 0);
}

export function origin(step: UpsellStepId, downsellSlot?: number): string {
  const base = step === "ty" ? "vendor_thank_you" : `vendor_${step}`;
  return downsellSlot ? `${base}_ds${downsellSlot}` : base;
}

type RevenueFilter = {
  /** The step: its offer's and its downsells' sales (vendor_up1, vendor_up1_ds1…). */
  step?: UpsellStepId;
  /** Only the step's offer (false) or only its downsells (true). */
  downsell?: boolean;
  /** Only this downsell slot (1, 2…). */
  slot?: number;
  grp?: string;
  flow?: string;
  page?: string;
  offer?: string;
};

/** Sales and revenue tied by the order (exact) and by IP only (estimated). */
export type Money = { sales: number; revenue: number; estimatedSales: number; estimated: number };

/** The sales (orders) and revenue of the rows that match: `revenue` is the exact part, `estimated` the IP-only part. */
export function revenue(rows: UpsellRevenue[], f: RevenueFilter): Money {
  const base = f.step ? origin(f.step) : null;
  const out: Money = { sales: 0, revenue: 0, estimatedSales: 0, estimated: 0 };
  for (const r of rows) {
    if (base !== null) {
      const own = r.origin === base;
      const ds = r.origin.startsWith(`${base}_ds`);
      if (!own && !ds) continue;
      if (f.downsell === false && !own) continue;
      if (f.downsell === true && !ds) continue;
      if (f.slot !== undefined && r.origin !== `${base}_ds${f.slot}`) continue;
    }
    if ((f.grp !== undefined && r.grp !== f.grp) || (f.flow !== undefined && r.flow !== f.flow) || (f.page !== undefined && r.page !== f.page) || (f.offer !== undefined && r.offer !== f.offer)) continue;
    if (r.match_kind === "exact") {
      out.sales += r.sales;
      out.revenue += r.revenue;
    } else {
      out.estimatedSales += r.sales;
      out.estimated += r.revenue;
    }
  }
  return out;
}

/** A route's revenue over every step (exact and estimated) and the buyers who reached its first step (distinct IPs there). */
export function routeRevenue(route: UpsellRoute, served: UpsellServed[], rows: UpsellRevenue[]): { revenue: number; estimated: number; buyers: number } {
  let total = 0;
  let estimated = 0;
  let buyers = 0;
  for (const step of UPSELL_STEPS) {
    const grp = route.groups[step];
    if (!grp) continue;
    const m = revenue(rows, { step, grp });
    total += m.revenue;
    estimated += m.estimated;
    if (buyers === 0) buyers = served.filter((r) => r.step === step && r.grp === grp).reduce((a, r) => a + r.visitors, 0);
  }
  return { revenue: total, estimated, buyers };
}

export const fmtInt = (n: number) => n.toLocaleString("en-US");
/** "$1,234" (cents only under $100). */
export const fmtMoney = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });
/** Revenue per visit, or "—" without visits. */
export const fmtPerVisit = (money: number, visits: number) => (visits > 0 ? fmtMoney(money / visits) : "—");
export const fmtPct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "—");

/** The share of a group's visits that each flow took (Default included). */
export function flowShares(served: UpsellServed[], step: string, grp: string, flowIds: string[]): Map<string, { visits: number; share: string }> {
  const total = visits(served, { step, grp });
  const out = new Map<string, { visits: number; share: string }>();
  for (const id of [...flowIds, DEFAULT_FLOW]) {
    const v = visits(served, { step, grp, flow: id });
    out.set(id, { visits: v, share: fmtPct(v, total) });
  }
  return out;
}
