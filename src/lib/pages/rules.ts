import { supabaseService } from "@/lib/supabase/service";
import type { RuleConditions } from "./conditions";
import type { Rule, RuleBacktest } from "./rules-types";

export type { Rule } from "./rules-types";

/**
 * The traffic rules of the gate (pages.rules), for Server Components
 * (server-only — the shared types are in rules-types.ts). They DETECT bad
 * traffic: walked in order (position), the first whose conditions all match
 * marks the click with the rule's label and it gets the domain's page. A clean
 * click goes to the funnel of its sub1.
 *
 * A database error here THROWS, like the other queries modules.
 */

function throwIf(error: { message: string } | null, where: string) {
  if (error) throw new Error(`${where}: ${error.message}`);
}

export async function listRules(): Promise<Rule[]> {
  const { data, error } = await supabaseService().rpc("rules_list");
  throwIf(error, "rules_list");
  return ((data as Rule[] | null) ?? []).map((r) => ({
    ...r,
    is_monitor: r.is_monitor === true,
    tags: (r.tags ?? []) as string[],
    conditions: (r.conditions ?? {}) as RuleConditions,
  }));
}

/** Clicks (hits) and distinct IPs. */
export type RuleCount = { hits: number; uniques: number };

/**
 * The Rules screen's numbers since `since` (pages.rule_stats): per rule id,
 * the clicks it caught; and `passed`, the clicks that passed the gate (a
 * funnel page served with a 200, as the Dashboard counts them). The www entry
 * redirect isn't counted: the same click comes back on the bare domain.
 */
export async function ruleStats(since: Date): Promise<{ byRule: Map<string, RuleCount>; passed: RuleCount }> {
  const { data, error } = await supabaseService().rpc("rule_stats", { p_since: since.toISOString() });
  throwIf(error, "rule_stats");
  const byRule = new Map<string, RuleCount>();
  let passed: RuleCount = { hits: 0, uniques: 0 };
  for (const r of (data as { rule_id: string | null; hits: number | string; uniques: number | string }[] | null) ?? []) {
    const count = { hits: Number(r.hits), uniques: Number(r.uniques) };
    if (r.rule_id === null) passed = count;
    else byRule.set(r.rule_id, count);
  }
  return { byRule, passed };
}

/** A rule's numbers in a period, from the hourly rollup (pages.rule_totals). */
export type RuleTotals = {
  /** Clicks the rule served the safe page for (as ruleStats counts them). */
  blocked: number;
  /** Clicks whose rule_matches has the rule (not in Monitor) / has only it. */
  matched: number;
  alone: number;
  /** A Monitor rule: the clicks it matched that passed the gate (it would have blocked them), and of those loaded / interacted. */
  monitorPassed: number;
  monitorLoaded: number;
  monitorInteracted: number;
  /** Blocked per platform ("" = no platform), and what a Monitor rule would have blocked. */
  byPlatform: Map<string, { blocked: number; monitorPassed: number }>;
};

/** The nil uuid: a rule_matches entry of a rule that no longer exists (or a name shared by two rules). */
export const UNKNOWN_RULE_ID = "00000000-0000-0000-0000-000000000000";

const n = (v: number | string | null | undefined) => Number(v ?? 0);

/** Per rule since `since` (from its hour): pages.rule_totals. */
export async function ruleTotals(since: Date): Promise<Map<string, RuleTotals>> {
  const { data, error } = await supabaseService().rpc("rule_totals", { p_since: since.toISOString() });
  throwIf(error, "rule_totals");
  const out = new Map<string, RuleTotals>();
  type Row = { rule_id: string; platform: string; blocked: number; matched: number; alone: number; monitor_passed: number; monitor_loaded: number; monitor_interacted: number };
  for (const r of (data as Row[] | null) ?? []) {
    let t = out.get(r.rule_id);
    if (!t) {
      t = { blocked: 0, matched: 0, alone: 0, monitorPassed: 0, monitorLoaded: 0, monitorInteracted: 0, byPlatform: new Map() };
      out.set(r.rule_id, t);
    }
    t.blocked += n(r.blocked);
    t.matched += n(r.matched);
    t.alone += n(r.alone);
    t.monitorPassed += n(r.monitor_passed);
    t.monitorLoaded += n(r.monitor_loaded);
    t.monitorInteracted += n(r.monitor_interacted);
    const p = t.byPlatform.get(r.platform) ?? { blocked: 0, monitorPassed: 0 };
    p.blocked += n(r.blocked);
    p.monitorPassed += n(r.monitor_passed);
    t.byPlatform.set(r.platform, p);
  }
  return out;
}

/**
 * Per rule, the clicks it blocked (a Monitor rule: would have blocked) in each
 * bucket [bounds[i], bounds[i+1]) — the caller's local days. pages.rule_buckets.
 */
export async function ruleBuckets(bounds: Date[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (bounds.length < 2) return out;
  const { data, error } = await supabaseService().rpc("rule_buckets", { p_bounds: bounds.map((d) => d.toISOString()) });
  throwIf(error, "rule_buckets");
  for (const r of (data as { bucket: number; rule_id: string; blocked: number; monitor_passed: number }[] | null) ?? []) {
    const i = n(r.bucket) - 1;
    if (i < 0 || i >= bounds.length - 1) continue;
    const days = out.get(r.rule_id) ?? new Array<number>(bounds.length - 1).fill(0);
    days[i] += n(r.blocked) + n(r.monitor_passed);
    out.set(r.rule_id, days);
  }
  return out;
}

/** Per platform ("" = no platform) since `since`: what the gate caught and what passed. pages.gate_totals. */
export type GateTotals = { platform: string; bot: number; suspicious: number; passed: number; loaded: number; interacted: number };

export async function gateTotals(since: Date): Promise<GateTotals[]> {
  const { data, error } = await supabaseService().rpc("gate_totals", { p_since: since.toISOString() });
  throwIf(error, "gate_totals");
  return ((data as GateTotals[] | null) ?? []).map((r) => ({
    platform: r.platform,
    bot: n(r.bot),
    suspicious: n(r.suspicious),
    passed: n(r.passed),
    loaded: n(r.loaded),
    interacted: n(r.interacted),
  }));
}

/** How many clicks two rules both matched since `since`, on one platform (null = all). pages.rule_pairs. */
export async function rulePairs(since: Date, platform: string | null): Promise<{ a: string; b: string; n: number }[]> {
  const { data, error } = await supabaseService().rpc("rule_pairs", { p_since: since.toISOString(), p_platform: platform });
  throwIf(error, "rule_pairs");
  return ((data as { rule_a: string; rule_b: string; n: number }[] | null) ?? []).map((r) => ({ a: r.rule_a, b: r.rule_b, n: n(r.n) }));
}

/**
 * What a rule's conditions would have matched since `since` (pages.rule_backtest):
 * at most 7 days back for a rule scoped to platforms, 24 hours otherwise.
 * Returns the database error's code with it, so the action can word a check
 * violation (a bad regex) for the screen.
 */
export async function ruleBacktest(conditions: RuleConditions, since: Date): Promise<{ ok: true; value: RuleBacktest } | { ok: false; code: string; message: string }> {
  const { data, error } = await supabaseService().rpc("rule_backtest", { p_conditions: conditions, p_since: since.toISOString() });
  if (error) return { ok: false, code: error.code ?? "", message: error.message };
  return { ok: true, value: data as RuleBacktest };
}
