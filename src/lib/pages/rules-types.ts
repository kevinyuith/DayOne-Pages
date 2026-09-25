import type { RuleConditions } from "./conditions";

/**
 * The traffic rules' shared types (pages.rules) — safe to import from the
 * browser (no Supabase client here). The queries live in rules.ts (server-only).
 *
 * The rules DETECT bad traffic (Bot, Suspicious…); a clean click goes to the
 * funnel of its sub1 ([F…] token).
 */

/** The labels a rule can mark the click with (what the log shows). */
export const RULE_LABELS = ["Bot", "Suspicious"] as const;
export type RuleLabel = (typeof RULE_LABELS)[number];
export const isRuleLabel = (v: string): v is RuleLabel => (RULE_LABELS as readonly string[]).includes(v);

export type Rule = {
  id: string;
  name: string;
  /** The category recorded in the log when the rule matches (one of RULE_LABELS). */
  label: string;
  /** Why the rule flags the click ("Datacenter IP range"…); recorded in the log with the label. "" = none. */
  reason: string;
  tags: string[];
  conditions: RuleConditions;
  position: number;
  is_active: boolean;
};
