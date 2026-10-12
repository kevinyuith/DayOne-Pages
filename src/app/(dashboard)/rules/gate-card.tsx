import Link from "next/link";
import { ChevronRightIcon } from "@/components/icons";
import { PlatformTile } from "@/components/platform-chip";
import { platformLabel } from "@/lib/pages/dashboard-filters";
import type { GateTotals, Rule, RuleTotals } from "@/lib/pages/rules";
import { formatPct, rate } from "./rules-insights";

const num = new Intl.NumberFormat("en-US");

/** The fewest clicks judged in the period for a platform to get a row (the one in the filter always does). */
const MIN_JUDGED = 100;

/** How many platforms the card shows (by clicks judged), plus the one in the filter. */
const TOP_PLATFORMS = 6;
const TOP_RULES = 3;

/**
 * The three outcomes of the gate, in the Dashboard's hues (violet Bot, red
 * Suspicious, blue Passed), stepped so neighbours also differ in lightness.
 * Validated with the dataviz palette script against #ffffff and #141414.
 */
const SEGMENTS = [
  { key: "bot", label: "Bot", className: "bg-[#8b5cf6] dark:bg-[#7c3aed]" },
  { key: "suspicious", label: "Suspicious", className: "bg-[#b91c1c] dark:bg-[#ef4444]" },
  { key: "passed", label: "Passed", className: "bg-[#0ea5e9] dark:bg-[#0284c7]" },
] as const;

type TopRule = { id: string; name: string; blocked: number };

/** The rules of one label that blocked the most on a platform. */
function topRules(platform: string, isBot: boolean, rules: Rule[], totals: Map<string, RuleTotals>): TopRule[] {
  return rules
    .filter((r) => (r.label.toLowerCase() === "bot") === isBot)
    .map((r) => ({ id: r.id, name: r.name, blocked: totals.get(r.id)?.byPlatform.get(platform)?.blocked ?? 0 }))
    .filter((r) => r.blocked > 0)
    .sort((a, b) => b.blocked - a.blocked)
    .slice(0, TOP_RULES);
}

function TopList({ title, platform, rules }: { title: string; platform: string; rules: TopRule[] }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-xs font-medium text-muted">{title}</h3>
      {rules.length ? (
        <ol className="space-y-1">
          {rules.map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-3 text-sm">
              <Link href={`/logs?rule=${r.id}&platform=${encodeURIComponent(platform)}`} className="truncate hover:underline">
                {r.name}
              </Link>
              <span className="sensitive shrink-0 tabular-nums text-muted">{num.format(r.blocked)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted">None</p>
      )}
    </div>
  );
}

/**
 * The gate per platform (the click's sub11) in the period: of the clicks it
 * judged, how many a Bot rule caught, a Suspicious rule caught, and passed —
 * and, of those that passed, how many loaded and interacted. Each row opens
 * the platform's top Bot and Suspicious rules. Clicks with no platform are left out.
 */
export function GateCard({ gate, selected, rules, totals }: { gate: GateTotals[]; selected: string | null; rules: Rule[]; totals: Map<string, RuleTotals> }) {
  const judged = (g: GateTotals) => g.bot + g.suspicious + g.passed;
  // A sub11 nobody runs ads on ("_removed_", a scanner's junk) never fills a row: at least MIN_JUDGED clicks.
  const ranked = gate.filter((g) => g.platform !== "" && judged(g) >= MIN_JUDGED).sort((a, b) => judged(b) - judged(a));
  const shown = ranked.slice(0, TOP_PLATFORMS);
  const extra = selected ? gate.find((g) => g.platform === selected && judged(g) > 0) : undefined;
  if (extra && !shown.includes(extra)) shown.push(extra);
  if (!shown.length) return null;

  return (
    <section aria-labelledby="gate-card-title" className="mb-6 rounded-xl border border-border bg-surface" data-dash-content>
      <h2 id="gate-card-title" className="border-b border-border px-4 py-2.5 text-sm font-medium">
        Gate per platform
      </h2>
      {shown.map((g) => {
        const total = judged(g);
        const parts = SEGMENTS.map((s) => ({ ...s, value: g[s.key] }));
        return (
          <details key={g.platform} className="group border-b border-border last:border-b-0" open={g.platform === selected || undefined}>
            <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-x-6 gap-y-2 px-4 py-3 transition-colors hover:bg-foreground/[0.02] md:grid-cols-[9rem_minmax(0,1fr)_auto] [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 items-center gap-2">
                <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
                <PlatformTile tag={g.platform} />
                <span className="truncate text-sm font-medium">{platformLabel(g.platform)}</span>
              </span>

              <span className="min-w-0">
                <span className="flex h-2.5 gap-0.5 overflow-hidden rounded" aria-hidden>
                  {parts.map((p) =>
                    p.value > 0 ? (
                      <span key={p.key} className={p.className} style={{ width: `${(p.value / total) * 100}%` }} title={`${p.label}: ${num.format(p.value)}`} />
                    ) : null,
                  )}
                </span>
                <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                  {parts.map((p) => (
                    <span key={p.key} className="inline-flex items-center gap-1.5">
                      <span aria-hidden className={`size-2 rounded-sm ${p.className}`} />
                      {p.label}
                      <span className="sensitive tabular-nums text-foreground">{formatPct(p.value / total)}</span>
                    </span>
                  ))}
                  <span className="sensitive tabular-nums">{num.format(total)} judged</span>
                </span>
              </span>

              <span className="col-span-2 flex gap-6 pl-[1.375rem] md:col-span-1 md:pl-0 md:text-right">
                <span>
                  <span className="block text-xs text-muted">Loaded</span>
                  <span className="sensitive font-medium tabular-nums">{formatPct(rate(g.loaded, g.passed))}</span>
                </span>
                <span>
                  <span className="block text-xs text-muted">Interacted</span>
                  <span className="sensitive font-medium tabular-nums">{formatPct(rate(g.interacted, g.passed))}</span>
                </span>
              </span>
            </summary>
            <div className="grid gap-4 px-4 pb-4 pl-[2.375rem] sm:grid-cols-2">
              <TopList title="Top Bot rules" platform={g.platform} rules={topRules(g.platform, true, rules, totals)} />
              <TopList title="Top Suspicious rules" platform={g.platform} rules={topRules(g.platform, false, rules, totals)} />
            </div>
          </details>
        );
      })}
    </section>
  );
}
