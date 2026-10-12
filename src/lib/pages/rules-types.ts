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
  /** Monitor mode: an active rule that's evaluated and recorded (rule_matches) but never blocks. */
  is_monitor: boolean;
  created_at: string;
};

/** A rule's state: Active (blocks), Monitor (records only) or Paused (skipped). */
export const RULE_MODES = ["active", "monitor", "paused"] as const;
export type RuleMode = (typeof RULE_MODES)[number];
export const RULE_MODE_LABELS: Record<RuleMode, string> = { active: "Active", monitor: "Monitor", paused: "Paused" };
export const isRuleMode = (v: string): v is RuleMode => (RULE_MODES as readonly string[]).includes(v);
export const ruleMode = (r: Pick<Rule, "is_active" | "is_monitor">): RuleMode => (!r.is_active ? "paused" : r.is_monitor ? "monitor" : "active");

/** What pages.rule_backtest says a rule's conditions would have matched (since `since`). */
export type RuleBacktest = {
  since: string;
  total: number;
  ips: number;
  caught: number;
  safe_no_rule: number;
  checkpoint: number;
  not_found: number;
  funnel: number;
  funnel_loaded: number;
  funnel_interacted: number;
  other: number;
  caught_by: { rule: string; n: number }[];
  platforms: { platform: string; n: number }[];
  /** Condition keys a hit can't tell (prefetch, device signals…): the counts are an upper bound. */
  ignored: string[];
  /** Conditions a hit only records in part (referrer host, hostname). */
  approximate: string[];
};
