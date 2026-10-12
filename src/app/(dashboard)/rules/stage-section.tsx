import Link from "next/link";
import { RowAction } from "@/components/row-action";
import { PlatformChip } from "@/components/platform-chip";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { summarizeRuleConditions } from "@/lib/pages/conditions";
import { platformLabel } from "@/lib/pages/dashboard-filters";
import type { Rule, RuleTotals } from "@/lib/pages/rules";
import { RULE_MODE_LABELS, ruleMode, type RuleMode } from "@/lib/pages/rules-types";
import { moveRule, setRuleMode } from "./actions";
import { Overlap, type PairsPromise } from "./overlap";
import { RuleForm } from "./rule-form";
import { RuleMenu } from "./rule-menu";
import { rulePlatforms, uniqueCaseless } from "./rules-insights";
import { TrendCell, type Trends } from "./sparkline";
import { Uniques, type UniquesPromise } from "./uniques";

const num = new Intl.NumberFormat("en-US");

const MODE_TONE: Record<RuleMode, "success" | "info" | "warning"> = { active: "success", monitor: "info", paused: "warning" };

/** How many platforms the Blocked split names before "+N" (the full list is in the title). */
const SPLIT_MAX = 2;

/** "Facebook 4,247" / "TikTok 823" under a Blocked number, one per line, when the rule blocked on more than one platform. */
function PlatformSplit({ totals }: { totals: RuleTotals | undefined }) {
  const rows = [...(totals?.byPlatform ?? new Map<string, { blocked: number }>())].filter(([, v]) => v.blocked > 0).sort((a, b) => b[1].blocked - a[1].blocked);
  if (rows.length < 2) return null;
  const label = ([p, v]: (typeof rows)[number]) => `${p ? platformLabel(p) : "No platform"} ${num.format(v.blocked)}`;
  const more = rows.length - SPLIT_MAX;
  return (
    <span className="sensitive mt-0.5 block whitespace-nowrap text-[11px] leading-snug text-muted tabular-nums" title={rows.map(label).join(" · ")}>
      {rows.slice(0, SPLIT_MAX).map((row) => (
        <span key={row[0]} className="block">
          {label(row)}
        </span>
      ))}
      {more > 0 ? <span className="block">+{more} more</span> : null}
    </span>
  );
}

/**
 * One stage of the walk (Bot, then Suspicious — the order the gate runs them).
 * The rules come already in position order; the Order column numbers them within
 * the stage and the ↑/↓ move a rule among its own stage (rule_move stays within
 * the label). Matched = every click whose rules matched it, Alone = the ones no
 * other rule matched; Blocked = the ones it served the safe page for. A rule
 * that caught nothing in the period is dimmed.
 */
export function StageSection({
  label,
  tone,
  rules,
  totals,
  uniques,
  trends,
  platformOptions,
  overlap,
}: {
  label: string;
  tone: "danger" | "warning";
  rules: Rule[];
  totals: Map<string, RuleTotals>;
  uniques: UniquesPromise;
  trends: Trends;
  platformOptions: string[];
  overlap: { pairs: PairsPromise; platform: string | null };
}) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        <span className="text-xs text-muted">{rules.length}</span>
      </div>
      <Table data-dash-content>
        <thead>
          <tr>
            <Th className="w-px">Order</Th>
            <Th>Rule</Th>
            <Th>Platform</Th>
            <Th>Conditions</Th>
            <Th>Status</Th>
            <Th className="text-right">Actions</Th>
            <Th className="text-right">Matched</Th>
            <Th className="text-right">Alone</Th>
            <Th className="text-right">Blocked</Th>
            <Th>14 days</Th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => {
            const t = totals.get(r.id);
            const blocked = t?.blocked ?? 0;
            const matched = t?.matched ?? 0;
            const alone = t?.alone ?? 0;
            const mode = ruleMode(r);
            const platforms = uniqueCaseless([...r.tags, ...rulePlatforms(r.conditions)]);
            return (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap">
                  <span className="flex items-center gap-1.5">
                    <span className="w-5 text-right text-xs tabular-nums text-muted">{i + 1}</span>
                    <span className="inline-flex flex-col">
                      {i > 0 ? <RowAction action={moveRule.bind(null, r.id, -1)} label="↑" pendingLabel="…" variant="ghost" size="sm" /> : <span className="h-7" />}
                      {i < rules.length - 1 ? <RowAction action={moveRule.bind(null, r.id, 1)} label="↓" pendingLabel="…" variant="ghost" size="sm" /> : <span className="h-7" />}
                    </span>
                  </span>
                </Td>
                <Td className={blocked ? "" : "opacity-55"}>
                  <span className="font-medium">{r.name}</span>
                  {r.reason ? <span className="block text-xs text-muted">{r.reason}</span> : null}
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {platforms.length ? platforms.map((p) => <PlatformChip key={p} tag={p} />) : <span className="text-xs text-muted">—</span>}
                  </span>
                </Td>
                <Td className="max-w-64">
                  <span className="line-clamp-2 text-xs text-muted" title={summarizeRuleConditions(r.conditions)}>{summarizeRuleConditions(r.conditions)}</span>
                </Td>
                <Td>
                  <Badge tone={MODE_TONE[mode]}>{RULE_MODE_LABELS[mode]}</Badge>
                </Td>
                <Td className="text-right">
                  <span className="inline-flex items-center gap-2">
                    <RuleForm rule={r} platformOptions={platformOptions} />
                    <RowAction action={setRuleMode.bind(null, r.id, mode === "paused" ? "active" : "paused")} label={mode === "paused" ? "Activate" : "Pause"} pendingLabel="…" />
                    <RuleMenu id={r.id} name={r.name} mode={mode} />
                  </span>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Link href={`/logs?matched=${r.id}`} title="See them in the Logs" className={`sensitive tabular-nums hover:underline ${matched ? "" : "text-muted"}`}>
                    {num.format(matched)}
                  </Link>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  {matched > 0 && alone === 0 ? (
                    <Badge tone="warning">Never alone</Badge>
                  ) : (
                    <span className={`sensitive tabular-nums ${alone ? "" : "text-muted"}`}>{num.format(alone)}</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Link href={`/logs?rule=${r.id}`} title="See them in the Logs" className="group sensitive inline-block tabular-nums">
                    <span className={`font-medium group-hover:underline ${blocked ? "" : "text-muted"}`}>{num.format(blocked)}</span>
                    <Uniques stats={uniques} id={r.id} />
                  </Link>
                  <PlatformSplit totals={t} />
                </Td>
                <Td>
                  <TrendCell trends={trends} id={r.id} />
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <Overlap rules={rules} totals={totals} pairs={overlap.pairs} platform={overlap.platform} />
    </section>
  );
}
