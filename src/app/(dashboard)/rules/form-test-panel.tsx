"use client";

import { useState, useTransition, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { SELECT_BASE } from "@/components/ui/field";
import type { RuleBacktest } from "@/lib/pages/rules-types";
import { APP_TZ } from "@/lib/time-zone";
import { testRule, type RuleTestResult, type TestWindow } from "./actions";

const num = new Intl.NumberFormat("en-US");
const pctFmt = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const sinceFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: APP_TZ });

const WINDOWS: { value: TestWindow; label: string; scopedOnly?: true }[] = [
  { value: "24h", label: "Last 24 hours" },
  { value: "3d", label: "Last 3 days", scopedOnly: true },
  { value: "7d", label: "Last 7 days", scopedOnly: true },
];

/**
 * Where the requests the conditions match went, in the bar's order. Colors:
 * the dataviz reference palette's categorical steps (light / dark), an order
 * that passes its validator in both modes against #ffffff / #141414; blue =
 * reached the funnel, like the Dashboard's Passed.
 */
const OUTCOMES = [
  { key: "caught", label: "Already caught", color: "bg-[#6250d6] dark:bg-[#9085e9]" },
  { key: "safe_no_rule", label: "Safe page (no rule)", color: "bg-[#eb6834] dark:bg-[#d95926]" },
  { key: "checkpoint", label: "Stopped at checkpoint", color: "bg-[#1baf7a] dark:bg-[#199e70]" },
  { key: "not_found", label: "Not found", color: "bg-[#eda100] dark:bg-[#c98500]" },
  { key: "other", label: "Other", color: "bg-[#e87ba4] dark:bg-[#d55181]" },
  { key: "funnel", label: "Reached the funnel", color: "bg-[#2a78d6] dark:bg-[#3987e5]" },
] as const satisfies readonly { key: keyof RuleBacktest; label: string; color: string }[];

/**
 * "Test": runs the form's CURRENT conditions (saved or not) over the requests
 * already logged (testRule → pages.rule_backtest) without submitting the form.
 * 3 and 7 days only for a rule scoped to platforms (`scoped`).
 */
export function TestPanel({ formRef, scoped, disabled }: { formRef: RefObject<HTMLFormElement | null>; scoped: boolean; disabled: boolean }) {
  const [picked, setPicked] = useState<TestWindow>("24h");
  const span: TestWindow = scoped ? picked : "24h";
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const [pending, start] = useTransition();

  const run = () => {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    fd.set("test_window", span);
    start(async () => {
      setResult(await testRule(fd));
    });
  };

  return (
    <fieldset className="mt-5 min-w-0 rounded-lg border border-border p-3" aria-busy={pending}>
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Test</legend>
      <div className="flex flex-wrap items-center gap-2">
        <label>
          <span className="sr-only">Test window</span>
          <select value={span} onChange={(e) => setPicked(e.target.value as TestWindow)} className={`${SELECT_BASE} w-40`} disabled={disabled || pending}>
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value} disabled={w.scopedOnly && !scoped}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="secondary" onClick={run} disabled={disabled || pending}>
          {pending ? "Testing…" : "Run test"}
        </Button>
      </div>
      {result ? (
        result.ok ? (
          <TestResult r={result.result} baseline={result.baseline} />
        ) : (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {result.error}
          </p>
        )
      ) : null}
    </fieldset>
  );
}

function TestResult({ r, baseline }: { r: RuleBacktest; baseline: { passed: number; loaded: number; interacted: number } }) {
  const parts = OUTCOMES.map((o) => ({ ...o, n: r[o.key] })).filter((o) => o.n > 0);
  const share = (n: number) => (r.total ? n / r.total : 0);
  return (
    <div className="mt-3 text-sm" role="status">
      <p>
        <span className="font-medium tabular-nums">{num.format(r.total)}</span> requests · <span className="tabular-nums">{num.format(r.ips)}</span> IPs
        <span className="text-muted"> · since {sinceFmt.format(new Date(r.since))}</span>
      </p>

      {r.total > 0 ? (
        <>
          <div
            role="img"
            aria-label={`Where they went: ${parts.map((o) => `${o.label} ${num.format(o.n)}`).join(", ")}`}
            className="mt-2 flex h-3 gap-0.5 overflow-hidden rounded"
          >
            {parts.map((o) => (
              <span
                key={o.key}
                title={`${o.label}: ${num.format(o.n)} (${pctFmt.format(share(o.n))})`}
                className={`h-full min-w-1 ${o.color}`}
                style={{ flexGrow: o.n, flexBasis: 0 }}
              />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {parts.map((o) => (
              <li key={o.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={`size-2.5 shrink-0 rounded-sm ${o.color}`} />
                <span className="text-muted">{o.label}</span>
                <span className="font-medium tabular-nums">{num.format(o.n)}</span>
                <span className="tabular-nums text-muted">{pctFmt.format(share(o.n))}</span>
              </li>
            ))}
          </ul>
          {r.caught_by.length ? (
            <p className="mt-2 text-xs">
              <span className="text-muted">Already caught — </span>
              {r.caught_by.map((c, i) => (
                <span key={c.rule}>
                  {i ? <span className="text-muted"> · </span> : null}
                  {c.rule} <span className="tabular-nums text-muted">{num.format(c.n)}</span>
                </span>
              ))}
            </p>
          ) : null}
        </>
      ) : null}

      {r.funnel > 0 ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <RateGroup label="Loaded" n={r.funnel_loaded} of={r.funnel} base={baseline.loaded} baseOf={baseline.passed} />
          <RateGroup label="Interacted" n={r.funnel_interacted} of={r.funnel} base={baseline.interacted} baseOf={baseline.passed} />
        </div>
      ) : null}

      {r.ignored.length ? <p className="mt-2 text-xs text-muted">Not tested: {r.ignored.join(", ")} — so the numbers are an upper bound.</p> : null}
      {r.approximate.length ? <p className="mt-1 text-xs text-muted">Approximate: {r.approximate.join(", ")}</p> : null}
    </div>
  );
}

/** Of the clicks that reached the funnel, the share that loaded (or interacted), next to every click that passed on the same platforms. */
function RateGroup({ label, n, of, base, baseOf }: { label: string; n: number; of: number; base: number; baseOf: number }) {
  return (
    <div>
      <p className="text-xs font-medium">{label}</p>
      <Rate label="These clicks" value={of ? n / of : null} bar="bg-accent" />
      <Rate label="All passed" value={baseOf ? base / baseOf : null} bar="bg-foreground/35" />
    </div>
  );
}

function Rate({ label, value, bar }: { label: string; value: number | null; bar: string }) {
  return (
    <div className="mt-1 flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
        {value !== null ? <span className={`block h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, value * 100)}%` }} /> : null}
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums">{value !== null ? pctFmt.format(value) : "—"}</span>
    </div>
  );
}
