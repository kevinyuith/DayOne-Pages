"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { parseRuleConditionsForm } from "@/lib/pages/conditions";
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
  const isActive = fd.get("is_active") === "on" || fd.get("is_active") === "true";

  if (id && !UUID_RE.test(id)) return { error: "Invalid rule.", attempt };
  if (name.length < 1 || name.length > 120) return { error: "Name is required (up to 120 characters).", attempt };
  if (label.length < 1 || label.length > 60) return { error: "Label is required (up to 60 characters) — it's what the log shows (Bot, Suspicious…).", attempt };

  const tags = Array.from(new Set(String(fd.get("tags") ?? "").split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)));
  if (tags.length > 10) return { error: "Up to 10 tags.", attempt };
  const badTag = tags.find((t) => !TAG_RE.test(t));
  if (badTag) return { error: `Invalid tag "${badTag}".`, attempt };

  const cond = parseRuleConditionsForm(fd);
  if (!cond.ok) return { error: cond.reason, attempt };

  try {
    const { error } = await supabaseService().rpc("rule_save", {
      p_id: id,
      p_name: name,
      p_label: label,
      p_tags: tags,
      p_conditions: cond.value,
      p_is_active: isActive,
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
