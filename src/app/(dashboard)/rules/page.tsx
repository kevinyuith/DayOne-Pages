import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { summarizeRuleConditions } from "@/lib/pages/conditions";
import { parseRange, resolveRange } from "@/lib/pages/dashboard-filters";
import { listRules, ruleStats, type RuleCount } from "@/lib/pages/rules";
import { deleteRule, duplicateRule, moveRule, setRuleActive } from "./actions";
import { RuleForm } from "./rule-form";
import { RulesFilters } from "./rules-filters";

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
 * The rules, in the order the gate walks them, with how many clicks each one
 * caught in the period (?range=, the Dashboard's periods) and, last, the clicks
 * that passed the gate; each number opens those hits in the Logs. ?flow= shows
 * only the rules with that flow (tag).
 */
export default async function RulesPage({ searchParams }: { searchParams: Promise<{ flow?: string; range?: string }> }) {
  // Dynamic Server Component: reading the clock per request is intentional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const { flow, range: rangeParam } = await searchParams;
  const range = parseRange(rangeParam);
  const [all, stats] = await Promise.all([listRules(), ruleStats(resolveRange(range, nowMs).since)]);
  // The flows in use (the rules' tags), for the filter.
  const flows = [...new Set(all.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b));
  const selected = typeof flow === "string" && flows.includes(flow) ? flow : null;
  const rules = selected ? all.filter((r) => r.tags.includes(selected)) : all;

  return (
    <>
      <PageHeader title="Rules" />

      <section className="mb-8 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Add rule</h2>
        <p className="mt-1 text-xs text-muted">
          The rules walk in order and the first whose conditions all match marks the click with its label and sends it to the domain&apos;s page. A
          click that matches no rule is clean and goes to the funnel named in its sub1 ([F…] token).
        </p>
        <RuleForm />
      </section>

      {all.length ? <RulesFilters range={range} flow={selected} flows={flows} /> : null}

      {rules.length === 0 ? (
        <EmptyState
          title={selected ? `No rules with the flow "${selected}"` : "No rules"}
          description={selected ? "Clear the filter to see every rule." : "Create the first rule above. With no rules, every click is clean and goes to the funnel of its sub1."}
        />
      ) : (
        <Table data-dash-content>
          <thead>
            <tr>
              <Th className="w-px">Order</Th>
              <Th>Rule</Th>
              <Th>Label</Th>
              <Th>Flow</Th>
              <Th>Conditions</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
              <Th className="text-right">Blocked</Th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap">
                  <span className="inline-flex flex-col">
                    <RowAction action={moveRule.bind(null, r.id, -1)} label="↑" pendingLabel="…" variant="ghost" size="sm" />
                    <RowAction action={moveRule.bind(null, r.id, 1)} label="↓" pendingLabel="…" variant="ghost" size="sm" />
                  </span>
                </Td>
                <Td>
                  <span className="font-medium">{r.name}</span>
                  {r.reason ? <span className="block text-xs text-muted">{r.reason}</span> : null}
                </Td>
                <Td>
                  <Badge tone={r.label.toLowerCase() === "bot" ? "danger" : "warning"}>{r.label}</Badge>
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
                  <span className="inline-flex gap-2">
                    <RuleForm rule={r} />
                    <RowAction action={duplicateRule.bind(null, r.id)} label="Duplicate" pendingLabel="…" />
                    <RowAction action={setRuleActive.bind(null, r.id, !r.is_active)} label={r.is_active ? "Pause" : "Activate"} pendingLabel="…" />
                    <RowAction action={deleteRule.bind(null, r.id)} label="Delete" variant="danger" confirm={`Delete the rule "${r.name}"?`} />
                  </span>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Count count={stats.byRule.get(r.id)} href={`/logs?rule=${r.id}`} />
                </Td>
              </Tr>
            ))}
            <Tr>
              <Td />
              <Td colSpan={6}>
                <span className="font-medium">Passed</span>
              </Td>
              <Td className="whitespace-nowrap text-right">
                <Count count={stats.passed} href="/logs?funnel=sent" />
              </Td>
            </Tr>
          </tbody>
        </Table>
      )}
    </>
  );
}
