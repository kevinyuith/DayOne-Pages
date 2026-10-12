import { Suspense } from "react";
import { ChevronRightIcon } from "@/components/icons";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { platformLabel } from "@/lib/pages/dashboard-filters";
import type { Rule, RuleTotals } from "@/lib/pages/rules";

/** pages.rule_pairs: how many clicks two rules both matched (null when the query failed). */
export type PairsPromise = Promise<{ a: string; b: string; n: number }[] | null>;

/** The most matched rules the matrix shows. */
const MAX_RULES = 12;

const num = new Intl.NumberFormat("en-US");

/** A matrix cell: narrow, centered, in table figures. */
const CELL = "w-12 px-2 py-2.5 text-center tabular-nums";

async function Matrix({ rules, totals, pairs, platform }: { rules: Rule[]; totals: Map<string, RuleTotals>; pairs: PairsPromise; platform: string | null }) {
  const got = await pairs;
  if (!got) return <p className="px-4 pb-4 text-sm text-muted">Couldn’t load the overlap.</p>;

  const both = new Map<string, number>();
  const paired = new Set<string>();
  for (const p of got) {
    both.set(`${p.a}|${p.b}`, p.n);
    both.set(`${p.b}|${p.a}`, p.n);
    if (p.n > 0) paired.add(p.a).add(p.b);
  }

  const matched = (r: Rule) => totals.get(r.id)?.matched ?? 0;
  const onPlatform = (r: Rule) => platform === null || paired.has(r.id) || (totals.get(r.id)?.byPlatform.get(platform)?.blocked ?? 0) > 0;
  const shown = rules
    .filter((r) => matched(r) > 0 && onPlatform(r))
    .sort((a, b) => matched(b) - matched(a))
    .slice(0, MAX_RULES);

  if (shown.length < 2) return <p className="px-4 pb-4 text-sm text-muted">Fewer than two rules matched</p>;

  return (
    <div className="px-4 pb-4">
      <Table>
        <thead>
          <tr>
            <Th>{platform === null ? "% of the row's matches" : "% of the row's matches, all platforms"}</Th>
            {shown.map((c, j) => (
              <th key={c.id} scope="col" title={c.name} aria-label={c.name} className={`${CELL} border-b border-border text-xs font-medium text-muted`}>
                {j + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => {
            const total = matched(r);
            return (
              <Tr key={r.id}>
                <Td className="max-w-72">
                  <span className="flex items-baseline gap-2" title={r.name}>
                    <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted">{i + 1}</span>
                    <span className="truncate">{r.name}</span>
                    <span className="sensitive ml-auto shrink-0 text-xs tabular-nums text-muted">{num.format(total)}</span>
                  </span>
                </Td>
                {shown.map((c) => {
                  if (c.id === r.id) {
                    return (
                      <td key={c.id} className={`${CELL} border-b border-border text-muted`}>
                        —
                      </td>
                    );
                  }
                  const n = both.get(`${r.id}|${c.id}`) ?? 0;
                  const share = Math.min(1, n / total);
                  const pct = share * 100;
                  return (
                    <td
                      key={c.id}
                      title={`${r.name} and ${c.name}: ${num.format(n)} of ${num.format(total)}`}
                      className={`${CELL} sensitive border-b border-border text-xs ${n ? "" : "text-muted"}`}
                      style={n ? { background: `color-mix(in srgb, var(--accent) ${Math.round(share * 55)}%, transparent)` } : undefined}
                    >
                      {n ? (pct < 1 ? "<1%" : `${Math.round(pct)}%`) : "0"}
                    </td>
                  );
                })}
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

/**
 * A stage's overlap: for its most matched rules, the share of each row rule's
 * matched clicks that the column rule also matched (pages.rule_pairs on one
 * platform — the filter's, or the stage's biggest). Per-platform matched
 * totals don't exist, so the share is of the row rule's matches on every
 * platform (the header says so). Closed by default; the matrix streams in.
 */
export function Overlap(props: { rules: Rule[]; totals: Map<string, RuleTotals>; pairs: PairsPromise; platform: string | null }) {
  return (
    <details className="group mt-2 rounded-xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
        Overlap
        <span className="font-normal text-muted">· {props.platform === null ? "All platforms" : props.platform === "" ? "No platform" : platformLabel(props.platform)}</span>
      </summary>
      <Suspense fallback={<p className="px-4 pb-4 text-sm text-muted">Loading…</p>}>
        <Matrix {...props} />
      </Suspense>
    </details>
  );
}
