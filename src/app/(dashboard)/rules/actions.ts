"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { parseRuleConditionsForm } from "@/lib/pages/conditions";
import { gateTotals, ruleBacktest } from "@/lib/pages/rules";
import { RULE_LABELS, isRuleLabel, isRuleMode, type RuleBacktest, type RuleMode } from "@/lib/pages/rules-types";
import { supabaseService } from "@/lib/supabase/service";

/**
 * Traffic rule actions (the gate's detection rules).
 *
 * Writes go through the pages.rule_* functions: the database validates the
 * shape (name, label, tags, conditions, the UA regex). The gate's data is
 * cached by the delivery servers (CACHE_TTL, 30 s) — a change takes effect on
 * expiry.
 */

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const NO_DATA = "P0002";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^.{1,40}$/;

function revalidateRules() {
  revalidatePath("/rules");
}

export type RuleFormState = { error?: string; success?: string; attempt: number };

export async function saveRule(prev: RuleFormState, fd: FormData): Promise<RuleFormState> {
  const attempt = prev.attempt + 1;
  const id = String(fd.get("rule_id") ?? "").trim() || null;
  const name = String(fd.get("name") ?? "").trim();
  const label = String(fd.get("label") ?? "").trim();
  const reason = String(fd.get("reason") ?? "").trim();
  // Active / Monitor / Paused (an older form posts only the is_active checkbox).
  const modeField = String(fd.get("mode") ?? "");
  const mode: RuleMode = isRuleMode(modeField) ? modeField : fd.get("is_active") === "on" || fd.get("is_active") === "true" ? "active" : "paused";

  if (id && !UUID_RE.test(id)) return { error: "Invalid rule.", attempt };
  if (name.length < 1 || name.length > 120) return { error: "Name is required (up to 120 characters).", attempt };
  if (!isRuleLabel(label)) return { error: `Choose the label: ${RULE_LABELS.join(" or ")}.`, attempt };
  if (reason.length > 200) return { error: "The reason goes up to 200 characters.", attempt };

  const tags = Array.from(new Set(String(fd.get("tags") ?? "").split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)));
  if (tags.length > 10) return { error: "Up to 10 platforms.", attempt };
  const badTag = tags.find((t) => !TAG_RE.test(t));
  if (badTag) return { error: `Invalid platform "${badTag}".`, attempt };

  const cond = parseRuleConditionsForm(fd);
  if (!cond.ok) return { error: cond.reason, attempt };

  try {
    const { error } = await supabaseService().rpc("rule_save", {
      p_id: id,
      p_name: name,
      p_label: label,
      p_tags: tags,
      p_conditions: cond.value,
      p_is_active: mode !== "paused",
      p_reason: reason,
      p_is_monitor: mode === "monitor",
      // This form knows every condition key: what it leaves out is removed.
      p_full: true,
    });
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { error: "A rule with that name already exists.", attempt };
      if (error.code === CHECK_VIOLATION) return { error: `Invalid data: ${error.message}`, attempt };
      if (error.code === NO_DATA) return { error: "Rule not found (was it removed?). Reload the page.", attempt };
      throw new Error(error.message);
    }
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }

  revalidateRules();
  return { success: id ? `${name} saved. It takes effect on the servers within 30 s.` : `${name} created. It takes effect on the servers within 30 s.`, attempt };
}

export async function deleteRule(id: string): Promise<ActionResult> {
  if (!UUID_RE.test(id)) return fail("Invalid rule.");
  try {
    const { error } = await supabaseService().rpc("rule_delete", { p_id: id });
    if (error) throw new Error(error.message);
  } catch (cause) {
    return fail(errorReason(cause));
  }
  revalidateRules();
  return { ok: true };
}

/** Duplicates a rule: a copy with a free name ("… (copy)"), same label, platforms, conditions and state, at the end of the walk. */
export async function duplicateRule(id: string): Promise<ActionResult> {
  if (!UUID_RE.test(id)) return fail("Invalid rule.");
  try {
    const db = supabaseService();
    const got = await db.from("rules").select("name,label,tags,conditions,is_active,is_monitor,reason").eq("id", id).maybeSingle();
    if (got.error) throw new Error(got.error.message);
    const src = got.data as { name: string; label: string; tags: unknown; conditions: unknown; is_active: boolean; is_monitor: boolean; reason: string | null } | null;
    if (!src) return fail("Rule not found.");
    // A name that isn't taken: "<name> (copy)", then "(copy 2)"…, within 120 characters.
    const names = new Set((((await db.from("rules").select("name")).data as { name: string }[] | null) ?? []).map((r) => r.name));
    const base = src.name.slice(0, 108);
    let name = `${base} (copy)`;
    for (let i = 2; names.has(name); i++) name = `${base} (copy ${i})`;
    const { error } = await db.rpc("rule_save", {
      p_id: null,
      p_name: name,
      p_label: src.label,
      p_tags: Array.isArray(src.tags) ? src.tags : [],
      p_conditions: src.conditions ?? {},
      p_is_active: src.is_active,
      p_reason: src.reason ?? "",
      p_is_monitor: src.is_monitor === true,
      p_full: true,
    });
    if (error) throw new Error(error.message);
  } catch (cause) {
    return fail(errorReason(cause));
  }
  revalidateRules();
  return { ok: true };
}

/** Pause/resume without opening the form. */
export async function setRuleActive(id: string, active: boolean): Promise<ActionResult> {
  if (!UUID_RE.test(id)) return fail("Invalid rule.");
  try {
    const { error } = await supabaseService().from("rules").update({ is_active: active }).eq("id", id);
    if (error) throw new Error(error.message);
  } catch (cause) {
    return fail(errorReason(cause));
  }
  revalidateRules();
  return { ok: true };
}

/** Active (blocks), Monitor (records, never blocks) or Paused, without opening the form. */
export async function setRuleMode(id: string, mode: RuleMode): Promise<ActionResult> {
  if (!UUID_RE.test(id) || !isRuleMode(mode)) return fail("Invalid rule.");
  try {
    const { error } = await supabaseService()
      .from("rules")
      .update({ is_active: mode !== "paused", is_monitor: mode === "monitor" })
      .eq("id", id);
    if (error) throw new Error(error.message);
  } catch (cause) {
    return fail(errorReason(cause));
  }
  revalidateRules();
  return { ok: true };
}

/** How far back "Test" looks: 24 hours for any rule; 3 or 7 days only for a rule scoped to platforms. */
export type TestWindow = "24h" | "3d" | "7d";
const TEST_WINDOW_MS: Record<TestWindow, number> = { "24h": 86_400_000, "3d": 3 * 86_400_000, "7d": 7 * 86_400_000 };

export type RuleTestResult =
  | {
      ok: true;
      result: RuleBacktest;
      /** The clicks that passed on the same platforms in the same period: the yardstick for the ones this rule would block. */
      baseline: { passed: number; loaded: number; interacted: number };
    }
  | { ok: false; error: string };

/**
 * Runs the form's CURRENT conditions (saved or not) over the hits already
 * logged (pages.rule_backtest). Nothing is saved.
 */
export async function testRule(fd: FormData): Promise<RuleTestResult> {
  const cond = parseRuleConditionsForm(fd);
  if (!cond.ok) return { ok: false, error: cond.reason };
  const field = String(fd.get("test_window") ?? "24h");
  const window: TestWindow = field === "3d" || field === "7d" ? field : "24h";
  const scoped = (cond.value.sub11_in?.length ?? 0) > 0;
  // Dynamic Server Action: reading the clock per call is intentional.
  const since = new Date(Date.now() - TEST_WINDOW_MS[scoped ? window : "24h"]);
  try {
    const run = await ruleBacktest(cond.value, since);
    if (!run.ok) {
      if (run.code === CHECK_VIOLATION) return { ok: false, error: `Invalid conditions: ${run.message}` };
      throw new Error(run.message);
    }
    const platforms = new Set(scoped ? cond.value.sub11_in : run.value.platforms.map((p) => p.platform));
    const baseline = { passed: 0, loaded: 0, interacted: 0 };
    for (const g of await gateTotals(new Date(run.value.since))) {
      if (!platforms.has(g.platform)) continue;
      baseline.passed += g.passed;
      baseline.loaded += g.loaded;
      baseline.interacted += g.interacted;
    }
    return { ok: true, result: run.value, baseline };
  } catch (cause) {
    return { ok: false, error: errorReason(cause) };
  }
}

/** Moves a rule one step in the walk order (dir: -1 up, +1 down). */
export async function moveRule(id: string, dir: -1 | 1): Promise<ActionResult> {
  if (!UUID_RE.test(id)) return fail("Invalid rule.");
  try {
    const { error } = await supabaseService().rpc("rule_move", { p_id: id, p_dir: dir });
    if (error) throw new Error(error.message);
  } catch (cause) {
    return fail(errorReason(cause));
  }
  revalidateRules();
  return { ok: true };
}
