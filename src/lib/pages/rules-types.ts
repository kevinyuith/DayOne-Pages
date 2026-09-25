import type { RuleConditions } from "./conditions";

/**
 * The traffic rules' shared types (pages.rules) — safe to import from the
 * browser (no Supabase client here). The queries live in rules.ts (server-only).
 *
 * The rules DETECT bad traffic (Bot, Suspicious…); a clean click goes to the
 * funnel of its sub1 ([F…] token).
 */

export type Rule = {
  id: string;
  name: string;
  /** The category recorded in the log when the rule matches (Bot, Suspicious… — free text). */
  label: string;
  tags: string[];
  conditions: RuleConditions;
  position: number;
  is_active: boolean;
};
