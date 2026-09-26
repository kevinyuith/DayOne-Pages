"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CHECKBOX_CLASS, Field, INPUT_BASE, INPUT_CLASS, SELECT_BASE, SELECT_CLASS } from "@/components/ui/field";
import { DEVICES, DEVICE_LABELS, ruleConditionsToForm } from "@/lib/pages/conditions";
import { RULE_LABELS, isRuleLabel, type Rule } from "@/lib/pages/rules-types";
import { saveRule, type RuleFormState } from "./actions";

const INITIAL: RuleFormState = { attempt: 0 };


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
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl"
      >
        <FormBody rule={rule} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

function FormBody({ rule, onDone }: { rule?: Rule; onDone: () => void }) {
  const initial = ruleConditionsToForm(rule?.conditions);
  const [state, action, pending] = useActionState(saveRule, INITIAL);

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
          <select name="label" defaultValue={rule && isRuleLabel(rule.label) ? rule.label : RULE_LABELS[0]} className={SELECT_CLASS} disabled={pending}>
            {RULE_LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Flow" hint="Comma-separated.">
          <input name="tags" defaultValue={(rule?.tags ?? []).join(", ")} maxLength={200} placeholder="Facebook" className={INPUT_CLASS} disabled={pending} />
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Reason" hint="What the log shows when this rule catches a click.">
          <input name="reason" defaultValue={rule?.reason ?? ""} maxLength={200} placeholder="Datacenter IP range" className={INPUT_CLASS} disabled={pending} />
        </Field>
      </div>

      <ConditionsBuilder initial={initial} disabled={pending} />

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

/** The kinds of condition a rule can use. "URL parameter" can repeat; the others go once. */
type CondType = "user_agent" | "ips" | "asns" | "hostname" | "param" | "countries" | "languages" | "devices" | "referrer";
const COND_TYPES: { type: CondType; label: string; repeat?: true }[] = [
  { type: "user_agent", label: "User-Agent" },
  { type: "ips", label: "IP" },
  { type: "asns", label: "ASN" },
  { type: "hostname", label: "Hostname" },
  { type: "param", label: "URL parameter", repeat: true },
  { type: "countries", label: "Country" },
  { type: "languages", label: "Language" },
  { type: "devices", label: "Device" },
  { type: "referrer", label: "Referrer" },
];
const COND_LABEL = Object.fromEntries(COND_TYPES.map((c) => [c.type, c.label])) as Record<CondType, string>;

/** A URL parameter row: "contains"/"not equals"/"absent or equals" is the rule's `param` (one per rule); the others go into `query`. */
type ParamRowMode = "present" | "absent" | "equals" | "not_equals" | "absent_or_equals" | "contains";
const PARAM_ROW_MODES: ParamRowMode[] = ["present", "absent", "equals", "not_equals", "absent_or_equals", "contains"];
const PARAM_ROW_LABELS: Record<ParamRowMode, string> = {
  present: "present",
  absent: "absent",
  equals: "equals",
  not_equals: "not equals",
  absent_or_equals: "absent or equals",
  contains: "contains",
};
/** Modes that post as the rule's single `param` (the rest go into `query`). */
const PARAM_AS_PARAM: ReadonlySet<ParamRowMode> = new Set(["contains", "not_equals", "absent_or_equals"]);
type Row = { id: number; type: CondType; key?: string; mode?: ParamRowMode; value?: string };

/** A saved rule's rows: one per condition it has (an old sub1/sub11 condition shows as a URL parameter). */
function initialRows(initial: ReturnType<typeof ruleConditionsToForm>): Row[] {
  const rows: Omit<Row, "id">[] = [];
  if (initial.userAgent) rows.push({ type: "user_agent" });
  if (initial.ips) rows.push({ type: "ips" });
  if (initial.asns) rows.push({ type: "asns" });
  if (initial.hostname) rows.push({ type: "hostname" });
  for (const q of initial.query) rows.push({ type: "param", key: q.key, mode: q.mode, value: q.value });
  if (initial.paramName) rows.push({ type: "param", key: initial.paramName, mode: initial.paramMode, value: initial.paramValue });
  if (initial.countries) rows.push({ type: "countries" });
  if (initial.languages) rows.push({ type: "languages" });
  if (initial.devices.length) rows.push({ type: "devices" });
  if (initial.referrer) rows.push({ type: "referrer" });
  if (initial.sub11) rows.push({ type: "param", key: "sub11", mode: "equals", value: initial.sub11 });
  if (initial.sub1) rows.push({ type: "param", key: "sub1", mode: "equals", value: initial.sub1 });
  return rows.map((r, id) => ({ ...r, id }));
}

/**
 * The rule's conditions as a list: "+ Add condition" picks a kind (User-Agent,
 * URL parameter, country…) and each row has its fields and a remove button.
 * The rows post the same fields as before (parseRuleConditionsForm): a kind
 * that isn't in the list simply isn't sent. All rows must match (AND).
 */
function ConditionsBuilder({ initial, disabled }: { initial: ReturnType<typeof ruleConditionsToForm>; disabled: boolean }) {
  const [rows, setRows] = useState<Row[]>(() => initialRows(initial));
  const [menu, setMenu] = useState(false);
  const nextId = useRef(1000);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const used = new Set(rows.map((r) => r.type));
  const available = COND_TYPES.filter((c) => c.repeat || !used.has(c.type));
  const add = (type: CondType) => {
    setRows((cur) => [...cur, type === "param" ? { id: nextId.current++, type, key: "", mode: "present", value: "" } : { id: nextId.current++, type }]);
    setMenu(false);
  };
  const remove = (id: number) => setRows((cur) => cur.filter((r) => r.id !== id));
  const patch = (id: number, p: Partial<Row>) => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const containsTaken = (id: number) => rows.some((r) => r.id !== id && r.type === "param" && PARAM_AS_PARAM.has(r.mode ?? "present"));

  const input = `${INPUT_BASE} min-w-0 flex-1`;
  const op = "shrink-0 text-sm text-muted";
  const controls = (r: Row) => {
    switch (r.type) {
      case "user_agent":
        return (
          <>
            <select name="user_agent_mode" defaultValue={initial.userAgentMode} className={`${SELECT_BASE} w-40 shrink-0`} disabled={disabled} aria-label="User-Agent match">
              <option value="allow">matches</option>
              <option value="block">doesn&apos;t match</option>
            </select>
            <input name="user_agent" defaultValue={initial.userAgent} required placeholder="headless|python-requests" className={`${input} font-mono`} disabled={disabled} aria-label="User-Agent regex" />
          </>
        );
      case "ips":
      case "asns":
        return (
          <>
            <select
              name={`${r.type}_mode`}
              defaultValue={r.type === "ips" ? initial.ipsMode : initial.asnsMode}
              className={`${SELECT_BASE} w-40 shrink-0`}
              disabled={disabled}
              aria-label={`${COND_LABEL[r.type]} match`}
            >
              <option value="allow">is one of</option>
              <option value="block">is not one of</option>
            </select>
            <input
              name={r.type}
              defaultValue={r.type === "ips" ? initial.ips : initial.asns}
              required
              placeholder={r.type === "ips" ? "203.0.113.7, 10.0.0.0/8" : "16509, 15169"}
              className={`${input} font-mono`}
              disabled={disabled}
              aria-label={r.type === "ips" ? "IPs or CIDR ranges" : "AS numbers"}
            />
          </>
        );
      case "hostname":
        return (
          <>
            <select name="hostname_mode" defaultValue={initial.hostnameMode} className={`${SELECT_BASE} w-40 shrink-0`} disabled={disabled} aria-label="Hostname match">
              <option value="allow">matches</option>
              <option value="block">doesn&apos;t match</option>
            </select>
            <input name="hostname" defaultValue={initial.hostname} required placeholder="amazonaws|googleusercontent" className={`${input} font-mono`} disabled={disabled} aria-label="Hostname regex" />
          </>
        );
      case "countries":
      case "languages": {
        const isCountry = r.type === "countries";
        return (
          <>
            <select
              name={`${r.type}_mode`}
              defaultValue={isCountry ? initial.countriesMode : initial.languagesMode}
              className={`${SELECT_BASE} w-40 shrink-0`}
              disabled={disabled}
              aria-label={`${COND_LABEL[r.type]} match`}
            >
              <option value="allow">is one of</option>
              <option value="block">is not one of</option>
            </select>
            <input
              name={r.type}
              defaultValue={isCountry ? initial.countries : initial.languages}
              required
              placeholder={isCountry ? "US, CA" : "en, es"}
              className={`${input} ${isCountry ? "uppercase" : ""}`}
              disabled={disabled}
              aria-label={isCountry ? "Countries (ISO-2)" : "Languages (ISO 639-1)"}
            />
          </>
        );
      }
      case "devices":
        return (
          <span className="flex h-10 flex-wrap items-center gap-4">
            {DEVICES.map((d) => (
              <label key={d} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="devices" value={d} defaultChecked={initial.devices.includes(d)} className={CHECKBOX_CLASS} disabled={disabled} />
                {DEVICE_LABELS[d]}
              </label>
            ))}
          </span>
        );
      case "referrer":
        return (
          <>
            <span className={op}>contains</span>
            <input name="referrer" defaultValue={initial.referrer} required placeholder="facebook.com" className={input} disabled={disabled} aria-label="Referrer contains" />
          </>
        );
      case "param": {
        // "contains"/"not equals"/"absent or equals" posts as the rule's `param`, the rest as a `query` row. The value field
        // stays in the form even when unused (read-only, empty): the query lists are parallel.
        const asParam = PARAM_AS_PARAM.has(r.mode ?? "present");
        const needsValue = r.mode === "equals" || asParam;
        return (
          <>
            <input
              name={asParam ? "param_name" : "query_key"}
              value={r.key ?? ""}
              onChange={(e) => patch(r.id, { key: e.target.value })}
              required
              placeholder="gclid"
              className={`${INPUT_BASE} w-36 shrink-0 font-mono`}
              disabled={disabled}
              aria-label="Parameter name"
            />
            <select
              name={asParam ? "param_mode" : "query_mode"}
              value={r.mode ?? "present"}
              onChange={(e) => patch(r.id, { mode: e.target.value as ParamRowMode })}
              className={`${SELECT_BASE} w-32 shrink-0`}
              disabled={disabled}
              aria-label="Parameter match"
            >
              {PARAM_ROW_MODES.map((m) => (
                <option key={m} value={m} disabled={PARAM_AS_PARAM.has(m) && containsTaken(r.id)}>
                  {PARAM_ROW_LABELS[m]}
                </option>
              ))}
            </select>
            <input
              name={asParam ? "param_value" : "query_value"}
              value={needsValue ? (r.value ?? "") : ""}
              onChange={(e) => patch(r.id, { value: e.target.value })}
              readOnly={!needsValue}
              tabIndex={needsValue ? undefined : -1}
              required={needsValue}
              placeholder={needsValue ? "value" : "—"}
              className={`${input} min-w-[7rem] ${needsValue ? "" : "opacity-50"}`}
              disabled={disabled}
              aria-label="Parameter value"
            />
          </>
        );
      }
    }
  };

  return (
    <fieldset className="mt-4 min-w-0">
      <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Conditions</legend>
      {rows.length ? (
        <div className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
              <span className="text-sm font-medium sm:w-36 sm:shrink-0">{COND_LABEL[r.type]}</span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{controls(r)}</div>
              <button
                type="button"
                onClick={() => remove(r.id)}
                disabled={disabled}
                aria-label={`Remove ${COND_LABEL[r.type]}`}
                className="self-end rounded px-2 py-1 text-lg leading-none text-muted hover:bg-foreground/5 hover:text-foreground sm:self-center"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted">No condition: this rule catches every click.</p>
      )}
      <div ref={menuRef} className="relative mt-2">
        <Button size="sm" variant="ghost" onClick={() => setMenu((m) => !m)} disabled={disabled} aria-expanded={menu}>
          + Add condition
        </Button>
        {menu ? (
          <ul
            role="menu"
            className="absolute bottom-full left-0 z-10 mb-1 w-56 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setMenu(false);
              }
            }}
          >
            {available.map((c) => (
              <li key={c.type}>
                <button type="button" role="menuitem" onClick={() => add(c.type)} className="w-full px-3 py-1.5 text-left text-sm hover:bg-foreground/5">
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </fieldset>
  );
}
