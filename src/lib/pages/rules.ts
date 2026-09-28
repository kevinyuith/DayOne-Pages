import { supabaseService } from "@/lib/supabase/service";
import type { RuleConditions } from "./conditions";
import type { Rule } from "./rules-types";

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
