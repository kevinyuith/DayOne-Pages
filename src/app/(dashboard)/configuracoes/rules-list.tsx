"use client";

import { useState } from "react";
import type { DetectionRule } from "@/lib/pages/types";
import { DETECTION_RULE_TYPE_LABELS, CLASSIFICATION_LABELS } from "@/lib/pages/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteDetectionRule, toggleDetectionRule } from "./actions";
import { RuleForm } from "./rule-form";

type RulesListProps = {
  rules: DetectionRule[];
};

export function RulesList({ rules }: RulesListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleToggle = async (id: string, isActive: boolean) => {
    try {
      await toggleDetectionRule(id, !isActive);
    } catch (err) {
      console.error("Failed to toggle rule:", err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this rule?")) return;
    setDeleting(id);
    try {
      await deleteDetectionRule(id);
    } catch (err) {
      console.error("Failed to delete rule:", err);
      setDeleting(null);
    }
  };

  const ruleBeingEdited = editing ? rules.find((r) => r.id === editing) : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold mb-4">Detection rules</h2>

        {rules.length === 0 ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <p className="text-sm text-muted">No rules yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => (
              <div key={rule.id} className="rounded-lg border border-border/60 p-4 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-medium text-sm truncate">{rule.name}</h3>
                    <Badge tone={rule.classification === "bot" ? "warning" : "danger"}>{CLASSIFICATION_LABELS[rule.classification]}</Badge>
                    {!rule.is_active && <Badge tone="neutral">Inactive</Badge>}
                  </div>
                  <p className="text-xs text-muted mb-2">
                    <span className="font-mono">{DETECTION_RULE_TYPE_LABELS[rule.type]}</span>
                  </p>
                  <p className="text-xs text-muted truncate">Pattern: {rule.pattern}</p>
                  {rule.notes && <p className="text-xs text-muted mt-1">{rule.notes}</p>}
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button
                    size="sm"
                    variant={rule.is_active ? "secondary" : "ghost"}
                    onClick={() => handleToggle(rule.id, rule.is_active)}
                  >
                    {rule.is_active ? "Active" : "Inactive"}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(rule.id)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => handleDelete(rule.id)}
                    disabled={deleting === rule.id}
                  >
                    {deleting === rule.id ? "..." : "Delete"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-5 h-fit">
        <h2 className="text-sm font-semibold mb-4">{editing ? "Edit rule" : "New rule"}</h2>
        <RuleForm rule={ruleBeingEdited} onSuccess={() => setEditing(null)} />
      </section>
    </div>
  );
}
