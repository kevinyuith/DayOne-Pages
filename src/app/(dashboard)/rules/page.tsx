import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { summarizeRuleConditions } from "@/lib/pages/conditions";
import { parseRange, resolveRange } from "@/lib/pages/dashboard-filters";
import { listRules, ruleStats, type Rule, type RuleCount } from "@/lib/pages/rules";
import { moveRule, setRuleActive } from "./actions";
import { RuleForm } from "./rule-form";
import { RuleMenu } from "./rule-menu";
import { RulesFilters } from "./rules-filters";
import type { StageFilter } from "./rules-href";

export const metadata: Metadata = {
  title: "Rules",
};

const num = new Intl.NumberFormat("en-US");

/** A Blocked cell: the clicks, and the distinct IPs under them; a link to those hits in the Logs. */
function Count({ count, href }: { count: RuleCount | undefined; href: string }) {
  const { hits, uniques } = count ?? { hits: 0, uniques: 0 };
  return (
    <Link href={href} title="See them in the Logs" className="group sensitive inline-block tabular-nums">
      <span className={`font-medium group-hover:underline ${hits ? "" : "text-muted"}`}>{num.format(hits)}</span>
      <span className="block text-xs text-muted">{num.format(uniques)} unique</span>
    </Link>
  );
}

/**
 * One stage of the walk (Bot, then Suspicious — the order the gate runs them).
 * The rules come already in position order; the Order column numbers them within
 * the stage and the ↑/↓ move a rule among its own stage (rule_move stays within
 * the label). A rule that caught nothing in the period is dimmed.
 */
function StageSection({ step, label, tone, rules, byRule }: { step: number; label: string; tone: "danger" | "warning"; rules: Rule[]; byRule: Map<string, RuleCount> }) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-foreground/10 text-[11px] font-semibold tabular-nums">{step}</span>
        <Badge tone={tone}>{label}</Badge>
        <span className="text-xs text-muted">{rules.length}</span>
      </div>
      <Table data-dash-content>
        <thead>
          <tr>
            <Th className="w-px">Order</Th>
            <Th>Rule</Th>
            <Th>Flow</Th>
            <Th>Conditions</Th>
            <Th>Status</Th>
            <Th className="text-right">Actions</Th>
            <Th className="text-right">Blocked</Th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => {
            const caught = byRule.get(r.id);
            const dim = !(caught?.hits ?? 0);
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
                <Td className={dim ? "opacity-55" : ""}>
                  <span className="font-medium">{r.name}</span>
                  {r.reason ? <span className="block text-xs text-muted">{r.reason}</span> : null}
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {r.tags.length ? r.tags.map((t) => <Badge key={t} tone="info">{t}</Badge>) : <span className="text-xs text-muted">—</span>}
                  </span>
                </Td>
                <Td className="max-w-xs">
                  <span className="line-clamp-2 text-xs text-muted">{summarizeRuleConditions(r.conditions)}</span>
                </Td>
                <Td>{r.is_active ? <Badge tone="success">active</Badge> : <Badge tone="warning">paused</Badge>}</Td>
                <Td className="text-right">
                  <span className="inline-flex items-center gap-2">
                    <RuleForm rule={r} />
                    <RowAction action={setRuleActive.bind(null, r.id, !r.is_active)} label={r.is_active ? "Pause" : "Activate"} pendingLabel="…" />
                    <RuleMenu id={r.id} name={r.name} />
                  </span>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Count count={caught} href={`/logs?rule=${r.id}`} />
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}

/**
 * The rules, grouped by the two stages the gate walks — Bot first (on the
 * request), then Suspicious (after the device checkpoint, in the browser) —
 * each in its own order, with how many clicks each one caught in the period
 * (?range=) and, last, the clicks that passed the gate. ?q= searches by name/
 * reason, ?stage= shows one stage, ?flow= one flow (tag). Each number opens
 * those hits in the Logs.
 */
export default async function RulesPage({ searchParams }: { searchParams: Promise<{ flow?: string; range?: string; q?: string; stage?: string }> }) {
  // Dynamic Server Component: reading the clock per request is intentional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const { flow, range: rangeParam, q: qParam, stage: stageParam } = await searchParams;
  const range = parseRange(rangeParam);
  const [all, stats] = await Promise.all([listRules(), ruleStats(resolveRange(range, nowMs).since)]);

  const flows = [...new Set(all.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b));
  const selectedFlow = typeof flow === "string" && flows.includes(flow) ? flow : null;
  const q = (qParam ?? "").trim();
  const stage: StageFilter = stageParam === "bot" || stageParam === "suspicious" ? stageParam : null;

  const needle = q.toLowerCase();
  const rules = all.filter((r) => {
    if (selectedFlow && !r.tags.includes(selectedFlow)) return false;
    if (needle && !`${r.name} ${r.reason ?? ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const isBot = (r: Rule) => r.label.toLowerCase() === "bot";
  const bot = rules.filter(isBot);
  const suspicious = rules.filter((r) => !isBot(r));
  const filtered = selectedFlow !== null || q !== "" || stage !== null;

  return (
    <>
      <PageHeader title="Rules" />

      <div className="mb-6">
        <RuleForm />
      </div>

      {all.length ? <RulesFilters range={range} flow={selectedFlow} flows={flows} q={q} stage={stage} /> : null}

      {rules.length === 0 ? (
        <EmptyState
          title={filtered ? "No rules match" : "No rules"}
          description={filtered ? "Clear the filters to see every rule." : "Create the first rule above. With no rules, every click is clean and goes to the funnel of its sub1."}
        />
      ) : (
        <>
          {stage !== "suspicious" && bot.length ? <StageSection step={1} label="Bot" tone="danger" rules={bot} byRule={stats.byRule} /> : null}
          {stage !== "bot" && suspicious.length ? <StageSection step={2} label="Suspicious" tone="warning" rules={suspicious} byRule={stats.byRule} /> : null}

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
            <span className="text-sm font-medium">Passed</span>
            <Count count={stats.passed} href="/logs?funnel=sent" />
          </div>
        </>
      )}
    </>
  );
}
