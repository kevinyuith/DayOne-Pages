"use client";

import { useState } from "react";
import { INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import { DEVICES, DEVICE_LABELS, QUERY_MODE_LABELS, type QueryMode } from "@/lib/pages/conditions";
import { QUERY_MODES, RULE_KINDS, RULE_KIND_LABELS, ruleRows, rowsToWhen, type RuleKind, type RuleRow, type UpsellFlow } from "@/lib/pages/upsell-types";

/**
 * A flow's rule, edited right under the flow's header (it pushes the rows down).
 * The conditions are the rules' base ones plus cookies; all of them must match.
 * Every change goes to the draft at once.
 */
export function RuleEditor({ flow, onChange, onClose }: { flow: UpsellFlow; onChange: (flow: UpsellFlow) => void; onClose: () => void }) {
  const [rows, setRows] = useState<RuleRow[]>(() => ruleRows(flow.when));

  const commit = (next: RuleRow[]) => {
    setRows(next);
    onChange({ ...flow, when: rowsToWhen(next) });
  };
  const set = (i: number, patch: Partial<RuleRow>) => commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (kind: RuleKind) =>
    commit([...rows, { kind, name: kind === "cookie" ? "vsl_ok" : "", mode: "present", value: "", values: kind === "device" ? ["mobile"] : [], block: false }]);

  return (
    <div className="flex flex-col gap-3 border-l-4 border-accent bg-accent/5 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          Name
          <input value={flow.name} maxLength={60} onChange={(e) => onChange({ ...flow, name: e.target.value })} className={`${INPUT_CLASS} w-56`} />
        </label>
        <span className="text-xs text-muted">All conditions must match. Flows are checked in order; no match → Default.</span>
        <button type="button" onClick={onClose} className="ml-auto text-sm font-semibold text-accent">
          Close ▴
        </button>
      </div>

      {rows.length === 0 ? <p className="text-sm text-muted">No conditions: every buyer matches this flow.</p> : null}
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-8 text-right text-xs font-semibold text-muted">{i === 0 ? "if" : "and"}</span>
          <span className="w-40 font-medium">{RULE_KIND_LABELS[r.kind]}</span>
          {r.kind === "cookie" || r.kind === "param" ? (
            <>
              <input
                aria-label={r.kind === "cookie" ? "Cookie name" : "Parameter name"}
                value={r.name}
                placeholder={r.kind === "cookie" ? "vsl_ok" : "sub11"}
                onChange={(e) => set(i, { name: e.target.value })}
                className={`${INPUT_CLASS} w-40 font-mono`}
              />
              <select aria-label="Operator" value={r.mode} onChange={(e) => set(i, { mode: e.target.value as QueryMode })} className={`${SELECT_CLASS} w-40`}>
                {QUERY_MODES.map((m) => (
                  <option key={m} value={m}>
                    {QUERY_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
              {r.mode === "equals" ? (
                <input aria-label="Value" value={r.value} onChange={(e) => set(i, { value: e.target.value })} className={`${INPUT_CLASS} w-48`} />
              ) : null}
            </>
          ) : null}
          {r.kind === "country" || r.kind === "language" ? (
            <>
              <input
                aria-label={r.kind === "country" ? "Countries" : "Languages"}
                value={r.values.join(", ")}
                placeholder={r.kind === "country" ? "US, CA" : "en, es"}
                onChange={(e) => set(i, { values: e.target.value.split(/[\s,]+/).filter(Boolean) })}
                className={`${INPUT_CLASS} w-48`}
              />
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={r.block} onChange={(e) => set(i, { block: e.target.checked })} className="size-4 accent-accent" />
                not these
              </label>
            </>
          ) : null}
          {r.kind === "device"
            ? DEVICES.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={r.values.includes(d)}
                    onChange={(e) => set(i, { values: e.target.checked ? [...r.values, d] : r.values.filter((v) => v !== d) })}
                    className="size-4 accent-accent"
                  />
                  {DEVICE_LABELS[d]}
                </label>
              ))
            : null}
          {r.kind === "referrer" ? (
            <input aria-label="Referrer contains" value={r.value} placeholder="facebook.com" onChange={(e) => set(i, { value: e.target.value })} className={`${INPUT_CLASS} w-56`} />
          ) : null}
          <button type="button" aria-label="Remove condition" onClick={() => commit(rows.filter((_, j) => j !== i))} className="size-8 rounded-md text-muted hover:bg-foreground/5">
            ×
          </button>
        </div>
      ))}

      <div className="pl-10">
        <select
          aria-label="Add condition"
          value=""
          onChange={(e) => e.target.value && add(e.target.value as RuleKind)}
          className={`${SELECT_CLASS} w-56`}
        >
          <option value="">+ Add condition</option>
          {RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {RULE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
