"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { DETECTION_RULE_TYPE_LABELS, CLASSIFICATION_LABELS, type DetectionRule, DETECTION_RULE_TYPES, CLASSIFICATIONS } from "@/lib/pages/types";
import { createDetectionRule, updateDetectionRule } from "./actions";

type RuleFormProps = {
  rule?: DetectionRule;
  onSuccess?: () => void;
};

export function RuleForm({ rule, onSuccess }: RuleFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    const input = {
      type: formData.get("type"),
      name: String(formData.get("name")),
      pattern: String(formData.get("pattern")),
      classification: formData.get("classification"),
      priority: Number(formData.get("priority")),
      is_active: formData.get("is_active") === "on",
      notes: (formData.get("notes") as string) || null,
    };

    try {
      if (rule?.id) {
        await updateDetectionRule(rule.id, input);
      } else {
        await createDetectionRule(input);
      }
      onSuccess?.();
      e.currentTarget.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the rule");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <div>
        <label className="block text-sm font-medium mb-1">Rule type</label>
        <Select name="type" defaultValue={rule?.type ?? "user_agent"} required>
          {DETECTION_RULE_TYPES.map((type) => (
            <option key={type} value={type}>
              {DETECTION_RULE_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Name</label>
        <Input name="name" placeholder="E.g. Common scrapers" defaultValue={rule?.name ?? ""} required />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Pattern</label>
        <Textarea
          name="pattern"
          placeholder="Regex for UA, CIDR for IP, ISO-2 for country, etc"
          defaultValue={rule?.pattern ?? ""}
          required
          rows={3}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Classification</label>
        <Select name="classification" defaultValue={rule?.classification ?? "bot"} required>
          {CLASSIFICATIONS.map((cls) => (
            <option key={cls} value={cls}>
              {CLASSIFICATION_LABELS[cls]}
            </option>
          ))}
        </Select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Priority</label>
        <Input type="number" name="priority" placeholder="100" defaultValue={rule?.priority ?? 100} min="0" required />
      </div>

      <div>
        <label className="flex items-center gap-2">
          <Checkbox name="is_active" defaultChecked={rule?.is_active ?? true} />
          <span className="text-sm font-medium">Active</span>
        </label>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Notes</label>
        <Textarea name="notes" placeholder="Details about this rule..." defaultValue={rule?.notes ?? ""} rows={2} />
      </div>

      <Button type="submit" disabled={loading}>
        {loading ? "Saving..." : rule?.id ? "Update rule" : "Create rule"}
      </Button>
    </form>
  );
}
