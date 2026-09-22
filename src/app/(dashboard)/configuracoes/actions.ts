"use server";

import { supabaseService } from "@/lib/supabase/service";
import type { DetectionRule, DetectionRuleType, Classification } from "@/lib/pages/types";
import { isDetectionRuleType, isClassification } from "@/lib/pages/types";
import { revalidatePath } from "next/cache";

type RuleInput = {
  type: unknown;
  name: string;
  pattern: string;
  classification: unknown;
  priority: number;
  is_active: boolean;
  notes: string | null;
};

export async function createDetectionRule(input: RuleInput): Promise<DetectionRule> {
  if (!isDetectionRuleType(input.type)) throw new Error("Invalid rule type");
  if (!isClassification(input.classification)) throw new Error("Invalid classification");

  const { data, error } = await supabaseService()
    .from("detection_rules")
    .insert([
      {
        type: input.type,
        name: input.name,
        pattern: input.pattern,
        classification: input.classification,
        priority: input.priority,
        is_active: input.is_active,
        notes: input.notes,
      },
    ])
    .select();

  if (error) throw new Error(`Failed to create rule: ${error.message}`);
  if (!data?.[0]) throw new Error("No data returned");

  revalidatePath("/configuracoes");
  return data[0] as DetectionRule;
}

export async function updateDetectionRule(id: string, input: Partial<RuleInput>): Promise<DetectionRule> {
  const updates: Record<string, unknown> = {};

  if (input.type !== undefined) {
    if (!isDetectionRuleType(input.type)) throw new Error("Invalid rule type");
    updates.type = input.type;
  }
  if (input.classification !== undefined) {
    if (!isClassification(input.classification)) throw new Error("Invalid classification");
    updates.classification = input.classification;
  }
  if (input.name !== undefined) updates.name = input.name;
  if (input.pattern !== undefined) updates.pattern = input.pattern;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.is_active !== undefined) updates.is_active = input.is_active;
  if (input.notes !== undefined) updates.notes = input.notes;

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseService()
    .from("detection_rules")
    .update(updates)
    .eq("id", id)
    .select();

  if (error) throw new Error(`Failed to update rule: ${error.message}`);
  if (!data?.[0]) throw new Error("Rule not found");

  revalidatePath("/configuracoes");
  return data[0] as DetectionRule;
}

export async function deleteDetectionRule(id: string): Promise<void> {
  const { error } = await supabaseService().from("detection_rules").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete rule: ${error.message}`);
  revalidatePath("/configuracoes");
}

export async function toggleDetectionRule(id: string, isActive: boolean): Promise<void> {
  const { error } = await supabaseService()
    .from("detection_rules")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Failed to toggle rule: ${error.message}`);
  revalidatePath("/configuracoes");
}
