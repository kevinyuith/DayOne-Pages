import { Suspense } from "react";
import type { RuleCount } from "@/lib/pages/rules";

/** pages.rule_stats' exact distinct IPs (slow): one promise per request, null when it failed (the line is left out). */
export type UniquesPromise = Promise<{ byRule: Map<string, RuleCount>; passed: RuleCount } | null>;

const num = new Intl.NumberFormat("en-US");

async function Line({ stats, id }: { stats: UniquesPromise; id: string | null }) {
  const s = await stats;
  if (!s) return null;
  const count = id === null ? s.passed : s.byRule.get(id);
  return <span className="block text-xs text-muted">{num.format(count?.uniques ?? 0)} unique</span>;
}

/** The "N unique" line under a Blocked number (id null = the Passed row), streamed after the rest of the screen. */
export function Uniques({ stats, id }: { stats: UniquesPromise; id: string | null }) {
  return (
    <Suspense fallback={<span aria-hidden className="ml-auto mt-1 block h-3 w-14 animate-pulse rounded bg-foreground/[0.06]" />}>
      <Line stats={stats} id={id} />
    </Suspense>
  );
}
