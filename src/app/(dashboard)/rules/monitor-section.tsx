import Link from "next/link";
import { RowAction } from "@/components/row-action";
import { PlatformChip } from "@/components/platform-chip";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { platformLabel } from "@/lib/pages/dashboard-filters";
import type { GateTotals, Rule, RuleTotals } from "@/lib/pages/rules";
import { setRuleMode } from "./actions";
import { RuleForm } from "./rule-form";
import { RuleMenu } from "./rule-menu";
import { VERDICT_LABEL, formatPct, monitorVerdict, rate, rulePlatforms, type PassedCounts, type Verdict } from "./rules-insights";
import { TrendCell, type Trends } from "./sparkline";

const num = new Intl.NumberFormat("en-US");

const VERDICT_TONE: Record<Verdict, "neutral" | "success" | "danger"> = { few: "neutral", bot: "danger", human: "success", unclear: "neutral" };

/** Every click that passed on these platforms (none = every platform with one) in the period: the yardstick. */
function baseline(gate: GateTotals[], platforms: string[]): PassedCounts {
  const out = { passed: 0, loaded: 0, interacted: 0 };
  for (const g of gate) {
    if (platforms.length ? !platforms.includes(g.platform) : g.platform === "") continue;
    out.passed += g.passed;
    out.loaded += g.loaded;
    out.interacted += g.interacted;
  }
  return out;
}

function Bar({ value, className, label }: { value: number | null; className: string; label: string }) {
  return (
    <span className="flex items-center gap-2" title={label}>
      <span aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.07]">
        <span className={`block h-full rounded-full ${className}`} style={{ width: `${Math.min(1, value ?? 0) * 100}%` }} />
      </span>
      <span className="sensitive w-11 text-right text-xs tabular-nums">
        <span className="sr-only">{label}</span>
        <span aria-hidden>{formatPct(value)}</span>
      </span>
    </span>
  );
}

/** A Monitor rule's rate next to its platforms' baseline: two thin bars. */
function Compare({ rule, base, what, platforms }: { rule: number | null; base: number | null; what: string; platforms: string }) {
  return (
    <span className="flex w-36 flex-col gap-1">
      <Bar value={rule} className="bg-accent" label={`This rule: ${formatPct(rule)} ${what}`} />
      <Bar value={base} className="bg-foreground/30" label={`${platforms}: ${formatPct(base)} ${what}`} />
    </span>
  );
}

/**
 * The rules in Monitor: they never block, so what they'd have blocked passed
 * the gate — and how those clicks loaded and interacted, next to every click
 * that passed on the rule's platforms, says whether the rule would catch bots
 * or people (the Verdict).
 */
export function MonitorSection({
  rules,
  totals,
  gate,
  trends,
  platformOptions,
}: {
  rules: Rule[];
  totals: Map<string, RuleTotals>;
  gate: GateTotals[];
  trends: Trends;
  platformOptions: string[];
}) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone="info">Monitor</Badge>
        <span className="text-xs text-muted">{rules.length}</span>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-3 rounded-full bg-accent" />
            Rule
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-3 rounded-full bg-foreground/30" />
            Baseline
          </span>
        </span>
      </div>
      <Table data-dash-content>
        <thead>
          <tr>
            <Th>Rule</Th>
            <Th>Platform</Th>
            <Th className="text-right">Would block</Th>
            <Th>Loaded</Th>
            <Th>Interacted</Th>
            <Th>Verdict</Th>
            <Th>14 days</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => {
            const t = totals.get(r.id);
            const counts: PassedCounts = { passed: t?.monitorPassed ?? 0, loaded: t?.monitorLoaded ?? 0, interacted: t?.monitorInteracted ?? 0 };
            const scope = rulePlatforms(r.conditions);
            const base = baseline(gate, scope);
            const verdict = monitorVerdict(counts, base);
            const baseName = scope.length ? `Baseline (${scope.map(platformLabel).join(", ")})` : "Baseline (all platforms)";
            return (
              <Tr key={r.id}>
                <Td className={counts.passed ? "" : "opacity-55"}>
                  <span className="font-medium">{r.name}</span>
                  {r.reason ? <span className="block text-xs text-muted">{r.reason}</span> : null}
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {scope.length ? scope.map((p) => <PlatformChip key={p} tag={p} />) : <span className="text-xs text-muted">All</span>}
                  </span>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Link href={`/logs?matched=${r.id}`} title="See them in the Logs" className={`sensitive font-medium tabular-nums hover:underline ${counts.passed ? "" : "text-muted"}`}>
                    {num.format(counts.passed)}
                  </Link>
                </Td>
                <Td>
                  <Compare rule={rate(counts.loaded, counts.passed)} base={rate(base.loaded, base.passed)} what="loaded" platforms={baseName} />
                </Td>
                <Td>
                  <Compare rule={rate(counts.interacted, counts.passed)} base={rate(base.interacted, base.passed)} what="interacted" platforms={baseName} />
                </Td>
                <Td>
                  <Badge tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict]}</Badge>
                </Td>
                <Td>
                  <TrendCell trends={trends} id={r.id} />
                </Td>
                <Td className="text-right">
                  <span className="inline-flex items-center gap-2">
                    <RowAction action={setRuleMode.bind(null, r.id, "active")} label="Activate" pendingLabel="…" />
                    <RuleForm rule={r} platformOptions={platformOptions} />
                    <RowAction action={setRuleMode.bind(null, r.id, "paused")} label="Pause" pendingLabel="…" />
                    <RuleMenu id={r.id} name={r.name} mode="monitor" />
                  </span>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}
