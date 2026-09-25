"use client";

import { useActionState, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CHECKBOX_CLASS, Field, INPUT_CLASS, SELECT_BASE, SELECT_CLASS } from "@/components/ui/field";
import {
  DEVICES,
  DEVICE_LABELS,
  LIST_MODES,
  LIST_MODE_LABELS,
  QUERY_MODES,
  QUERY_MODE_LABELS,
  ruleConditionsToForm,
  type ListMode,
  type ParamMode,
  type QueryRuleRow,
} from "@/lib/pages/conditions";
import type { Rule } from "@/lib/pages/rules-types";
import { saveRule, type RuleFormState } from "./actions";

const INITIAL: RuleFormState = { attempt: 0 };

const PARAM_MODES: ParamMode[] = ["equals", "contains", "present"];

/**
 * One traffic rule of the gate. In the table, "Add rule" (no rule) and "Edit"
 * (with one) open the same form in a dialog.
 */
export function RuleForm({ rule }: { rule?: Rule }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {rule ? (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Edit
        </Button>
      ) : (
        <div className="mt-3">
          <Button size="sm" onClick={() => setOpen(true)}>
            New rule
          </Button>
        </div>
      )}
      <Dialog
        open={open}
        title={rule ? `Edit ${rule.name}` : "New rule"}
        description="The first rule whose conditions all match marks the click with the label and sends it to the domain's page. Every condition is optional; empty matches everyone."
        onClose={() => setOpen(false)}
        className="max-w-2xl"
      >
        <FormBody rule={rule} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

function FormBody({ rule, onDone }: { rule?: Rule; onDone: () => void }) {
  const initial = ruleConditionsToForm(rule?.conditions);
  const [state, action, pending] = useActionState(saveRule, INITIAL);
  const [queryRows, setQueryRows] = useState<QueryRuleRow[]>(initial.query);
  const [paramMode, setParamMode] = useState<ParamMode>(initial.paramMode);

  if (state.success) {
    // Saved: the server revalidated the page; close the dialog.
    queueMicrotask(onDone);
  }

  return (
    <form action={action}>
      <input type="hidden" name="rule_id" value={rule?.id ?? ""} />

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_minmax(0,12rem)]">
        <Field label="Name" hint="E.g. Datacenter US.">
          <input name="name" defaultValue={rule?.name ?? ""} required maxLength={120} placeholder="Datacenter US" className={INPUT_CLASS} disabled={pending} />
        </Field>
        <Field label="Label" hint="What the log shows.">
          <input name="label" defaultValue={rule?.label ?? ""} required maxLength={60} placeholder="Bot" className={INPUT_CLASS} disabled={pending} />
        </Field>
        <Field label="Tags" hint="Comma-separated.">
          <input name="tags" defaultValue={(rule?.tags ?? []).join(", ")} maxLength={200} placeholder="Facebook" className={INPUT_CLASS} disabled={pending} />
        </Field>
      </div>

      <fieldset className="mt-4">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Conditions</legend>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <Field label="sub11 (exact)" hint="The click's platform id, case-insensitive.">
            <input name="sub11" defaultValue={initial.sub11} maxLength={120} placeholder="facebook" className={`${INPUT_CLASS} font-mono`} disabled={pending} />
          </Field>
          <Field label="sub1 (exact)" hint="The click's campaign id, case-insensitive.">
            <input name="sub1" defaultValue={initial.sub1} maxLength={120} placeholder="campanha-x" className={`${INPUT_CLASS} font-mono`} disabled={pending} />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Any URL parameter</span>
            <div className="flex gap-2">
              <input name="param_name" defaultValue={initial.paramName} placeholder="net" className={`${INPUT_CLASS} w-28 shrink-0 font-mono`} disabled={pending} aria-label="Parameter name" />
              <select name="param_mode" value={paramMode} onChange={(e) => setParamMode(e.target.value as ParamMode)} className={`${SELECT_BASE} w-28 shrink-0`} disabled={pending} aria-label="Parameter match">
                {PARAM_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <input name="param_value" defaultValue={initial.paramValue} placeholder={paramMode === "present" ? "—" : "value"} className={INPUT_CLASS} disabled={pending || paramMode === "present"} aria-label="Parameter value" />
            </div>
            <span className="text-xs text-muted">Any parameter of the click (e.g. net = dc), not just sub1/sub11</span>
          </div>
          <ListModeField
            label="User-Agent (regex)"
            name="user_agent"
            modeName="user_agent_mode"
            defaultMode={initial.userAgentMode}
            defaultValue={initial.userAgent}
            placeholder="chrome|firefox"
            hint="Case-insensitive partial match on the UA"
            disabled={pending}
          />
          <ListModeField
            label="Countries (ISO-2, comma-separated)"
            name="countries"
            modeName="countries_mode"
            defaultMode={initial.countriesMode}
            defaultValue={initial.countries}
            placeholder="BR, PT"
            hint="From Cloudflare's CF-IPCountry header"
            upper
            disabled={pending}
          />
          <ListModeField
            label="Languages (ISO 639-1, comma-separated)"
            name="languages"
            modeName="languages_mode"
            defaultMode={initial.languagesMode}
            defaultValue={initial.languages}
            placeholder="en, es"
            hint="From the browser's Accept-Language header"
            disabled={pending}
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Devices</span>
            <div className="flex h-10 items-center gap-4">
              {DEVICES.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="devices" value={d} defaultChecked={initial.devices.includes(d)} className={CHECKBOX_CLASS} disabled={pending} />
                  {DEVICE_LABELS[d]}
                </label>
              ))}
            </div>
          </div>
          <Field label="Referrer contains">
            <input name="referrer" defaultValue={initial.referrer} placeholder="facebook.com" className={INPUT_CLASS} disabled={pending} />
          </Field>
          <div className="md:col-span-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted">URL parameters</span>
              <Button size="sm" variant="ghost" onClick={() => setQueryRows([...queryRows, { key: "", mode: "present", value: "" }])} disabled={pending}>
                + parameter
              </Button>
            </div>
            {queryRows.length === 0 ? <p className="mt-1 text-xs text-muted">E.g. gclid present, or utm_source equals facebook.</p> : null}
            <div className="mt-1 flex flex-col gap-2">
              {queryRows.map((row, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_1fr_auto] gap-2">
                  <input
                    name="query_key"
                    value={row.key}
                    onChange={(e) => setQueryRows(queryRows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    placeholder="gclid"
                    className={`${INPUT_CLASS} h-9 font-mono`}
                    disabled={pending}
                  />
                  <select
                    name="query_mode"
                    value={row.mode}
                    onChange={(e) => setQueryRows(queryRows.map((r, j) => (j === i ? { ...r, mode: e.target.value as QueryRuleRow["mode"] } : r)))}
                    className={`${SELECT_CLASS} h-9`}
                    disabled={pending}
                  >
                    {QUERY_MODES.map((m) => (
                      <option key={m} value={m}>
                        {QUERY_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                  <input
                    name="query_value"
                    value={row.value}
                    onChange={(e) => setQueryRows(queryRows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    placeholder={row.mode === "equals" ? "value" : "—"}
                    className={`${INPUT_CLASS} h-9`}
                    disabled={pending || row.mode !== "equals"}
                  />
                  <Button size="sm" variant="ghost" onClick={() => setQueryRows(queryRows.filter((_, j) => j !== i))} disabled={pending}>
                    ×
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </fieldset>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" name="is_active" defaultChecked={rule?.is_active ?? true} className={CHECKBOX_CLASS} disabled={pending} />
        Active (a paused rule is skipped in the walk)
      </label>

      {state.error ? (
        <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.success ? <Alert tone="success" className="mt-4">{state.success}</Alert> : null}

      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : rule ? "Save rule" : "Create rule"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A field with a direction selector (allow only / block), for the UA regex and the country/language lists. */
function ListModeField({
  label,
  name,
  modeName,
  defaultMode,
  defaultValue,
  placeholder,
  hint,
  upper = false,
  disabled,
}: {
  label: string;
  name: string;
  modeName: string;
  defaultMode: ListMode;
  defaultValue: string;
  placeholder: string;
  hint: string;
  upper?: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="flex gap-2">
        <select name={modeName} defaultValue={defaultMode} className={`${SELECT_BASE} w-32 shrink-0`} disabled={disabled}>
          {LIST_MODES.map((m) => (
            <option key={m} value={m}>
              {LIST_MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <input name={name} defaultValue={defaultValue} placeholder={placeholder} className={`${INPUT_CLASS} ${upper ? "uppercase" : ""}`} disabled={disabled} />
      </div>
      <span className="text-xs text-muted">{hint}</span>
    </div>
  );
}
