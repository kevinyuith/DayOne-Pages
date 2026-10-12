"use client";

import { useRef, useState } from "react";
import { CHECKBOX_CLASS, INPUT_BASE, SELECT_BASE } from "@/components/ui/field";
import { DEVICES, DEVICE_LABELS, summarizeRuleConditions, type Device, type RuleException } from "@/lib/pages/conditions";
import type { RuleLabel } from "@/lib/pages/rules-types";
import { AddMenu, PARAM_AS_PARAM, PARAM_ROW_LABELS, PARAM_ROW_MODES, type ParamRowMode } from "./form-parts";

/** Up to 10 exceptions per rule (ruleConditionsSchema). */
const MAX_EXCEPTIONS = 10;

/** The on/off device signals an exception can use (Suspicious rules only), with what 1 and 0 read as. */
const SIGNAL_BITS: { key: string; label: string; on: string; off: string }[] = [
  { key: "touch", label: "Touchscreen", on: "capable", off: "not capable" },
  { key: "mobile_hint", label: "Mobile hint", on: "capable", off: "not capable" },
  { key: "webdriver", label: "Webdriver", on: "yes", off: "no" },
  { key: "automation", label: "Automation", on: "yes", off: "no" },
  { key: "gl_software", label: "Software WebGL", on: "yes", off: "no" },
  { key: "iframe", label: "In iframe", on: "yes", off: "no" },
  { key: "tostring_tampered", label: "toString tampered", on: "yes", off: "no" },
  { key: "proto_poisoned", label: "Proto poisoned", on: "yes", off: "no" },
  { key: "no_touch", label: "No touchscreen", on: "fired", off: "not fired" },
  { key: "chrome_ua", label: "Chrome UA", on: "yes", off: "no" },
  { key: "no_chrome_object", label: "No window.chrome", on: "fired", off: "not fired" },
  { key: "tz_mismatch", label: "TZ ≠ IP country", on: "fired", off: "not fired" },
  { key: "tz_not_us", label: "Non-US/CA/MX timezone", on: "fired", off: "not fired" },
  { key: "no_js", label: "No JavaScript", on: "fired", off: "not fired" },
  { key: "no_cookie", label: "Cookies disabled", on: "fired", off: "not fired" },
  { key: "odd_resolution", label: "Odd resolution", on: "fired", off: "not fired" },
  { key: "zoomed", label: "Browser zoom ≠ 100%", on: "zoomed", off: "not zoomed" },
];
const SIGNAL_KEYS = new Set(SIGNAL_BITS.map((s) => s.key));

type ExKind =
  | "user_agent"
  | "ips"
  | "asns"
  | "hostname"
  | "param"
  | "countries"
  | "languages"
  | "devices"
  | "referrer"
  | "referrer_absent"
  | "accept_languages"
  | "signal"
  | "screens";
const EX_KINDS: { type: ExKind; label: string; signal?: true }[] = [
  { type: "user_agent", label: "User-Agent" },
  { type: "ips", label: "IP" },
  { type: "asns", label: "ASN" },
  { type: "hostname", label: "Hostname" },
  { type: "param", label: "URL parameter" },
  { type: "countries", label: "Country" },
  { type: "languages", label: "Language" },
  { type: "devices", label: "Device" },
  { type: "referrer", label: "Referrer" },
  { type: "referrer_absent", label: "Referrer absent" },
  { type: "accept_languages", label: "Languages count" },
  { type: "signal", label: "Device signal", signal: true },
  { type: "screens", label: "Screen is", signal: true },
];
const EX_LABEL = Object.fromEntries(EX_KINDS.map((k) => [k.type, k.label])) as Record<ExKind, string>;

/**
 * One exception being edited. `mode` is the list/regex direction ("allow" |
 * "block"), the URL parameter's matcher, or a signal's "1"/"0"; `name` is the
 * parameter's or the signal's key; `value` the text (the min, for the
 * languages count); `max` the languages count's max. `orig` = the saved
 * exception, kept as is until the row is edited; a "raw" row (several keys,
 * made elsewhere) is only `orig`.
 */
type ExRow = { id: number; kind: ExKind | "raw"; mode: string; name: string; value: string; max: string; devices: Device[]; orig?: RuleException };
type Cond = Record<string, unknown>;

const BLANK = { mode: "allow", name: "", value: "", max: "", devices: [] as Device[] };

/** A saved exception as a row: its kind when it is one condition this block edits, otherwise read-only. */
function rowFromException(e: RuleException, id: number): ExRow {
  const keys = Object.keys(e);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  const dir = (m: string | undefined) => (m === "block" ? "block" : "allow");
  const row = (kind: ExKind, p: Partial<ExRow>): ExRow => ({ id, kind, ...BLANK, ...p, orig: e });
  if (e.user_agent && only("user_agent", "user_agent_mode")) return row("user_agent", { mode: dir(e.user_agent_mode), value: e.user_agent });
  if (e.ips && only("ips", "ips_mode")) return row("ips", { mode: dir(e.ips_mode), value: e.ips.join(", ") });
  if (e.asns && only("asns", "asns_mode")) return row("asns", { mode: dir(e.asns_mode), value: e.asns.join(", ") });
  if (e.hostname && only("hostname", "hostname_mode")) return row("hostname", { mode: dir(e.hostname_mode), value: e.hostname });
  if (e.param && only("param")) {
    const p = e.param;
    const [mode, value]: [ParamRowMode, string] =
      p.contains !== undefined
        ? ["contains", p.contains]
        : p.not_equals !== undefined
          ? ["not_equals", p.not_equals]
          : p.absent_or_equals !== undefined
            ? ["absent_or_equals", p.absent_or_equals]
            : p.equals !== undefined
              ? ["equals", p.equals]
              : ["present", ""];
    return row("param", { name: p.name, mode, value });
  }
  if (e.query && only("query") && Object.keys(e.query).length === 1) {
    const [name, rule] = Object.entries(e.query)[0];
    return row("param", { name, mode: typeof rule === "string" ? rule : "equals", value: typeof rule === "string" ? "" : rule.equals });
  }
  if (e.countries && only("countries", "countries_mode")) return row("countries", { mode: dir(e.countries_mode), value: e.countries.join(", ") });
  if (e.languages && only("languages", "languages_mode")) return row("languages", { mode: dir(e.languages_mode), value: e.languages.join(", ") });
  if (e.devices && only("devices")) return row("devices", { devices: [...e.devices] });
  if (e.referrer && only("referrer")) return row("referrer", { value: e.referrer });
  if (e.referrer_absent && only("referrer_absent")) return row("referrer_absent", {});
  if (e.accept_languages && only("accept_languages")) {
    const { min, max } = e.accept_languages;
    return row("accept_languages", { value: min !== undefined ? String(min) : "", max: max !== undefined ? String(max) : "" });
  }
  if (keys.length === 1 && SIGNAL_KEYS.has(keys[0])) return row("signal", { name: keys[0], mode: String((e as Cond)[keys[0]]) === "1" ? "1" : "0" });
  if (e.screens && only("screens")) return row("screens", { value: e.screens.join(", ") });
  return { id, kind: "raw", ...BLANK, orig: e };
}

/**
 * The row as ONE condition object (the keys of ruleConditionsSchema); null =
 * still empty (not sent — the required fields keep it from being saved).
 * The database and zod check the values again (an IP, a regex…).
 */
function rowToCondition(r: ExRow): Cond | null {
  if (r.orig) return r.orig;
  const words = (s: string) => [...new Set(s.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean))];
  const v = r.value.trim();
  const block = r.mode === "block";
  switch (r.kind) {
    case "user_agent":
      return v ? { user_agent: v, ...(block ? { user_agent_mode: "block" } : {}) } : null;
    case "hostname":
      return v ? { hostname: v, ...(block ? { hostname_mode: "block" } : {}) } : null;
    case "ips": {
      const ips = words(v);
      return ips.length ? { ips, ...(block ? { ips_mode: "block" } : {}) } : null;
    }
    case "asns": {
      // "AS" prefix allowed; a token that isn't a number goes as NaN (null in JSON) and the parser rejects it.
      const asns = words(v).map((t) => Number(/^(?:AS)?(\d{1,10})$/i.exec(t)?.[1] ?? NaN));
      return asns.length ? { asns: [...new Set(asns)], ...(block ? { asns_mode: "block" } : {}) } : null;
    }
    case "param": {
      const name = r.name.trim();
      const mode = r.mode as ParamRowMode;
      if (!name) return null;
      if (PARAM_AS_PARAM.has(mode)) return v ? { param: { name, [mode]: v } } : null;
      if (mode === "equals") return v ? { query: { [name]: { equals: v } } } : null;
      return { query: { [name]: mode } };
    }
    case "countries":
    case "languages": {
      const list = words(v).map((t) => (r.kind === "countries" ? t.toUpperCase() : t.toLowerCase()));
      return list.length ? { [r.kind]: list, ...(block ? { [`${r.kind}_mode`]: "block" } : {}) } : null;
    }
    case "devices":
      return r.devices.length ? { devices: r.devices } : null;
    case "referrer":
      return v ? { referrer: v } : null;
    case "referrer_absent":
      return { referrer_absent: true };
    case "accept_languages": {
      const al: { min?: number; max?: number } = {};
      if (/^\d{1,2}$/.test(v)) al.min = Number(v);
      if (/^\d{1,2}$/.test(r.max.trim())) al.max = Number(r.max.trim());
      return al.min !== undefined || al.max !== undefined ? { accept_languages: al } : null;
    }
    case "signal":
      return SIGNAL_KEYS.has(r.name) ? { [r.name]: r.mode === "1" ? 1 : 0 } : null;
    case "screens": {
      const screens = words(v.toLowerCase().replace(/×/g, "x"));
      return screens.length ? { screens } : null;
    }
    case "raw":
      return null;
  }
}

/**
 * "Except when" (any of these): conditions that keep a click out of the rule
 * even when all its conditions match. Each row is one condition object; the
 * list goes in the hidden `except_json` (parseRuleConditionsForm). The device
 * signals are offered only for Suspicious (the checkpoint knows them); a saved
 * exception with several keys (made elsewhere) shows as a read-only summary.
 */
export function ExceptionsBlock({ initial, label, disabled }: { initial: RuleException[]; label: RuleLabel; disabled: boolean }) {
  const [rows, setRows] = useState<ExRow[]>(() => initial.map((e, i) => rowFromException(e, i)));
  const nextId = useRef(1000);

  const add = (kind: ExKind) =>
    setRows((cur) => [
      ...cur,
      {
        id: nextId.current++,
        kind,
        ...BLANK,
        mode: kind === "param" ? "present" : kind === "signal" ? "1" : "allow",
        name: kind === "signal" ? SIGNAL_BITS[0].key : "",
      },
    ]);
  const remove = (id: number) => setRows((cur) => cur.filter((r) => r.id !== id));
  // Any edit drops the saved original: the row is rebuilt from its fields.
  const patch = (id: number, p: Partial<ExRow>) => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...p, orig: undefined } : r)));

  const list = rows.map(rowToCondition).filter((c): c is Cond => c !== null);
  const kinds = EX_KINDS.filter((k) => !k.signal || label === "Suspicious");

  const input = `${INPUT_BASE} min-w-0 flex-1`;
  const op = "shrink-0 text-sm text-muted";
  const dirSelect = (r: ExRow, yes: string, no: string) => (
    <select
      value={r.mode}
      onChange={(e) => patch(r.id, { mode: e.target.value })}
      className={`${SELECT_BASE} w-40 shrink-0`}
      disabled={disabled}
      aria-label={`${EX_LABEL[r.kind as ExKind]} match`}
    >
      <option value="allow">{yes}</option>
      <option value="block">{no}</option>
    </select>
  );
  const text = (r: ExRow, placeholder: string, aria: string, extra = "", props: { pattern?: string; title?: string } = {}) => (
    <input
      value={r.value}
      onChange={(e) => patch(r.id, { value: e.target.value })}
      required
      placeholder={placeholder}
      className={`${input} ${extra}`}
      disabled={disabled}
      aria-label={aria}
      {...props}
    />
  );

  const controls = (r: ExRow) => {
    switch (r.kind) {
      case "user_agent":
        return (
          <>
            {dirSelect(r, "matches", "doesn't match")}
            {text(r, "FBNV/500", "User-Agent regex", "font-mono")}
          </>
        );
      case "hostname":
        return (
          <>
            {dirSelect(r, "matches", "doesn't match")}
            {text(r, "comcast|verizon", "Hostname regex", "font-mono")}
          </>
        );
      case "ips":
        return (
          <>
            {dirSelect(r, "is one of", "is not one of")}
            {text(r, "203.0.113.7, 10.0.0.0/8", "IPs or CIDR ranges", "font-mono")}
          </>
        );
      case "asns":
        return (
          <>
            {dirSelect(r, "is one of", "is not one of")}
            {text(r, "7922, AS7018", "AS numbers", "font-mono", {
              pattern: "\\s*(?:[Aa][Ss])?\\d{1,10}(?:[\\s,;]+(?:[Aa][Ss])?\\d{1,10})*[\\s,;]*",
              title: "AS numbers, e.g. 7922 or AS7018",
            })}
          </>
        );
      case "countries":
        return (
          <>
            {dirSelect(r, "is one of", "is not one of")}
            {text(r, "US, CA", "Countries (ISO-2)", "uppercase placeholder:normal-case")}
          </>
        );
      case "languages":
        return (
          <>
            {dirSelect(r, "is one of", "is not one of")}
            {text(r, "en, es", "Languages (ISO 639-1)")}
          </>
        );
      case "referrer":
        return (
          <>
            <span className={op}>contains</span>
            {text(r, "facebook.com", "Referrer contains")}
          </>
        );
      case "referrer_absent":
        return <span className={op}>the Referer header is empty (no referrer)</span>;
      case "screens":
        return (
          <>
            <span className={op}>one of</span>
            {text(r, "1440x900, 1920x1080", "Screen sizes (W×H)", "font-mono")}
          </>
        );
      case "devices":
        return (
          <span role="group" aria-label="Devices" className="flex h-10 flex-wrap items-center gap-4">
            {DEVICES.map((d) => (
              <label key={d} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={r.devices.includes(d)}
                  onChange={(e) => patch(r.id, { devices: e.target.checked ? [...r.devices, d] : r.devices.filter((x) => x !== d) })}
                  // One of them must be picked: while none is, each is required.
                  required={r.devices.length === 0}
                  className={CHECKBOX_CLASS}
                  disabled={disabled}
                />
                {DEVICE_LABELS[d]}
              </label>
            ))}
          </span>
        );
      case "accept_languages":
        return (
          <>
            <span className={op}>between</span>
            <input
              value={r.value}
              onChange={(e) => patch(r.id, { value: e.target.value })}
              required={r.max.trim() === ""}
              inputMode="numeric"
              pattern="\d{1,2}"
              placeholder="min"
              className={`${INPUT_BASE} w-20 shrink-0 font-mono`}
              disabled={disabled}
              aria-label="Min languages"
            />
            <span className={op}>and</span>
            <input
              value={r.max}
              onChange={(e) => patch(r.id, { max: e.target.value })}
              required={r.value.trim() === ""}
              inputMode="numeric"
              pattern="\d{1,2}"
              placeholder="max"
              className={`${INPUT_BASE} w-20 shrink-0 font-mono`}
              disabled={disabled}
              aria-label="Max languages"
            />
            <span className={op}>language tags</span>
          </>
        );
      case "signal": {
        const sig = SIGNAL_BITS.find((s) => s.key === r.name) ?? SIGNAL_BITS[0];
        return (
          <>
            <select
              value={sig.key}
              onChange={(e) => patch(r.id, { name: e.target.value })}
              className={`${SELECT_BASE} min-w-0 flex-1 sm:max-w-56`}
              disabled={disabled}
              aria-label="Signal"
            >
              {SIGNAL_BITS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className={op}>is</span>
            <select
              value={r.mode}
              onChange={(e) => patch(r.id, { mode: e.target.value })}
              className={`${SELECT_BASE} w-36 shrink-0`}
              disabled={disabled}
              aria-label={`${sig.label} value`}
            >
              <option value="1">{sig.on}</option>
              <option value="0">{sig.off}</option>
            </select>
          </>
        );
      }
      case "param": {
        const mode = r.mode as ParamRowMode;
        const needsValue = mode === "equals" || PARAM_AS_PARAM.has(mode);
        return (
          <>
            <input
              value={r.name}
              onChange={(e) => patch(r.id, { name: e.target.value })}
              required
              placeholder="sub7"
              className={`${INPUT_BASE} w-36 shrink-0 font-mono`}
              disabled={disabled}
              aria-label="Parameter name"
            />
            <select
              value={mode}
              onChange={(e) => patch(r.id, { mode: e.target.value })}
              className={`${SELECT_BASE} w-32 shrink-0`}
              disabled={disabled}
              aria-label="Parameter match"
            >
              {PARAM_ROW_MODES.map((m) => (
                <option key={m} value={m}>
                  {PARAM_ROW_LABELS[m]}
                </option>
              ))}
            </select>
            <input
              value={needsValue ? r.value : ""}
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
      case "raw":
        return <span className="text-sm text-muted">{r.orig ? summarizeRuleConditions(r.orig) : ""}</span>;
    }
  };

  return (
    <fieldset className="mt-5 min-w-0">
      <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
        Except when <span className="font-normal normal-case tracking-normal">· any of these</span>
      </legend>
      <input type="hidden" name="except_json" value={list.length ? JSON.stringify(list) : ""} />
      {rows.length ? (
        <div className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => {
            const name = r.kind === "raw" ? "Combined" : EX_LABEL[r.kind];
            return (
              <div key={r.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                <span className="text-sm font-medium sm:w-36 sm:shrink-0">{name}</span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{controls(r)}</div>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  disabled={disabled}
                  aria-label={`Remove the ${name} exception`}
                  className="self-end rounded px-2 py-1 text-lg leading-none text-muted hover:bg-foreground/5 hover:text-foreground sm:self-center"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {rows.length < MAX_EXCEPTIONS ? <AddMenu label="+ Add exception" items={kinds} onPick={add} disabled={disabled} /> : null}
    </fieldset>
  );
}
