"use client";

import { Button } from "@/components/ui/button";
import { INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import { QUERY_MODES, QUERY_MODE_LABELS, type RuleRow } from "@/lib/pages/conditions";

/**
 * Linhas de regra "por nome" (parâmetros de URL, cookies) nos formulários de
 * rota e de filtro. Cada linha vira três campos paralelos no FormData
 * (`<prefix>_key`, `<prefix>_mode`, `<prefix>_value`) que
 * `parseConditionsForm` lê.
 */
export function RuleRows({
  prefix,
  title,
  addLabel,
  emptyHint,
  keyPlaceholder,
  rows,
  onChange,
  disabled,
}: {
  prefix: "query" | "cookie";
  title: string;
  addLabel: string;
  emptyHint: string;
  keyPlaceholder: string;
  rows: RuleRow[];
  onChange: (rows: RuleRow[]) => void;
  disabled?: boolean;
}) {
  const update = (i: number, patch: Partial<RuleRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="md:col-span-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{title}</span>
        <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { key: "", mode: "present", value: "" }])} disabled={disabled}>
          {addLabel}
        </Button>
      </div>
      {rows.length === 0 ? <p className="mt-1 text-xs text-muted">{emptyHint}</p> : null}
      <div className="mt-1 flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[1fr_8rem_1fr_auto] gap-2">
            <input name={`${prefix}_key`} value={row.key} onChange={(e) => update(i, { key: e.target.value })} placeholder={keyPlaceholder} className={`${INPUT_CLASS} h-9 font-mono`} disabled={disabled} />
            <select name={`${prefix}_mode`} value={row.mode} onChange={(e) => update(i, { mode: e.target.value as RuleRow["mode"] })} className={`${SELECT_CLASS} h-9`} disabled={disabled}>
              {QUERY_MODES.map((m) => (
                <option key={m} value={m}>
                  {QUERY_MODE_LABELS[m]}
                </option>
              ))}
            </select>
            <input
              name={`${prefix}_value`}
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={row.mode === "equals" ? "valor" : "—"}
              className={`${INPUT_CLASS} h-9`}
              disabled={disabled || row.mode !== "equals"}
            />
            <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} disabled={disabled}>
              ×
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
