import Link from "next/link";
import { ChevronRightIcon, WarningIcon } from "@/components/icons";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import type { Rule } from "@/lib/pages/rules";
import { ruleMode } from "@/lib/pages/rules-types";
import { APP_TZ } from "@/lib/time-zone";
import { setRuleMode } from "./actions";
import { TREND_DAYS } from "./rules-insights";

/** A spike of one rule: the New York day it happened (its start), the clicks and the median of the days before. */
export type RuleSpike = { rule: Rule; start: number; count: number; median: number };

const num = new Intl.NumberFormat("en-US");
const ratioFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, weekday: "short", month: "short", day: "numeric" });

/** "5.2× its median (80)", or "0 the previous days" when the median is 0. */
function versus(s: RuleSpike): string {
  return s.median > 0 ? `${ratioFmt.format(s.count / s.median)}× its median (${ratioFmt.format(s.median)})` : "0 the previous days";
}

/** Where a rule's clicks are in the Logs: the ones it served (a Monitor rule serves none: the ones it matched). */
const logsHref = (r: Rule) => (ruleMode(r) === "monitor" ? `/logs?matched=${r.id}` : `/logs?rule=${r.id}`);

/** One banner per spike today or yesterday (New York) of a rule that isn't paused, with what to do about it. */
export function SpikeBanners({ spikes, today, yesterday }: { spikes: RuleSpike[]; today: number; yesterday: number }) {
  const recent = spikes.filter((s) => (s.start === today || s.start === yesterday) && ruleMode(s.rule) !== "paused");
  if (!recent.length) return null;
  return (
    <div className="mb-6 space-y-2">
      {recent.map((s) => {
        const monitor = ruleMode(s.rule) === "monitor";
        return (
          <div
            key={`${s.rule.id}-${s.start}`}
            role="status"
            className="flex flex-col gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3.5 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-3"
          >
            <p className="flex min-w-0 flex-1 items-start gap-2.5">
              <WarningIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
              <span className="min-w-0">
                <span className="font-medium">{s.rule.name}</span>{" "}
                <span className="sensitive tabular-nums">
                  {monitor ? "would block" : "blocked"} {num.format(s.count)} {s.start === today ? "today" : "yesterday"}
                </span>{" "}
                <span className="text-muted">· {versus(s)}</span>
              </span>
            </p>
            <span className="flex shrink-0 flex-wrap items-start gap-2 pl-6 sm:pl-0">
              <Link href={logsHref(s.rule)} className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-500/10 dark:text-red-300">
                Open in Logs
              </Link>
              {monitor ? null : <RowAction action={setRuleMode.bind(null, s.rule.id, "monitor")} label="Switch to Monitor" pendingLabel="…" />}
              <RowAction action={setRuleMode.bind(null, s.rule.id, "paused")} label="Pause" pendingLabel="…" />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Every spike of the last TREND_DAYS days, newest first. */
export function SpikesCard({ spikes }: { spikes: RuleSpike[] }) {
  const rows = [...spikes].sort((a, b) => b.start - a.start || b.count - a.count);
  return (
    <details className="group mb-8 rounded-xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
        Spikes · last {TREND_DAYS} days
        <Badge tone={rows.length ? "danger" : "neutral"}>{rows.length}</Badge>
      </summary>
      <div className="px-4 pb-4">
        {rows.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Day</Th>
                <Th>Rule</Th>
                <Th className="text-right">Clicks</Th>
                <Th>Compared with</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Tr key={`${s.rule.id}-${s.start}`}>
                  <Td className="whitespace-nowrap text-muted">{dayFmt.format(s.start)}</Td>
                  <Td>
                    <Link href={logsHref(s.rule)} className="font-medium hover:underline">
                      {s.rule.name}
                    </Link>
                  </Td>
                  <Td className="sensitive text-right tabular-nums">{num.format(s.count)}</Td>
                  <Td className="text-xs text-muted">{versus(s)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-muted">No spikes</p>
        )}
      </div>
    </details>
  );
}
