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
