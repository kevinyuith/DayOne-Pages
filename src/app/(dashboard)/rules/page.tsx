import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { summarizeRuleConditions } from "@/lib/pages/conditions";
import { listRules } from "@/lib/pages/rules";
import { deleteRule, duplicateRule, moveRule, setRuleActive } from "./actions";
import { FlowFilter } from "./flow-filter";
import { RuleForm } from "./rule-form";

export const metadata: Metadata = {
  title: "Rules",
};

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ flow?: string }> }) {
  const { flow } = await searchParams;
  const all = await listRules();
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

      {all.length ? (
        <div className="mb-3 flex items-center justify-end gap-2">
          <FlowFilter flows={flows} value={selected} />
        </div>
      ) : null}

      {rules.length === 0 ? (
        <EmptyState
          title={selected ? `No rules with the flow "${selected}"` : "No rules"}
          description={selected ? "Clear the filter to see every rule." : "Create the first rule above. With no rules, every click is clean and goes to the funnel of its sub1."}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-px">Order</Th>
              <Th>Rule</Th>
              <Th>Label</Th>
              <Th>Flow</Th>
              <Th>Conditions</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
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
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
