import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { parseRange, resolveRange } from "@/lib/pages/dashboard-filters";
import { gateTotals, listRules, ruleBuckets, rulePairs, ruleStats, ruleTotals, type Rule, type RuleTotals } from "@/lib/pages/rules";
import { ruleMode } from "@/lib/pages/rules-types";
import { GateCard } from "./gate-card";
import { MonitorSection } from "./monitor-section";
import type { PairsPromise } from "./overlap";
import { RuleForm } from "./rule-form";
import { RulesFilters } from "./rules-filters";
import { parseStage } from "./rules-href";
import { SPIKE_LOOKBACK, TREND_DAYS, dayBounds, findSpikes, rulePlatforms, uniqueCaseless } from "./rules-insights";
import type { Trends } from "./sparkline";
import { SpikeBanners, SpikesCard, type RuleSpike } from "./spikes";
import { StageSection } from "./stage-section";
import { Uniques, type UniquesPromise } from "./uniques";

export const metadata: Metadata = {
  title: "Rules",
};

const num = new Intl.NumberFormat("en-US");

/** The platforms a rule is about: its scope (sub11_in) and its tags, lowercase. */
const rulePlatformKeys = (r: Rule) => [...rulePlatforms(r.conditions), ...r.tags.map((t) => t.toLowerCase())];

/** The platform where a stage's rules blocked the most (a named one before "" = no platform); null when they blocked nothing. */
function biggestPlatform(rules: Rule[], totals: Map<string, RuleTotals>): string | null {
  const sum = new Map<string, number>();
  for (const r of rules) for (const [p, v] of totals.get(r.id)?.byPlatform ?? []) sum.set(p, (sum.get(p) ?? 0) + v.blocked);
  const ranked = [...sum].filter(([, n]) => n > 0).sort((a, b) => Number(a[0] === "") - Number(b[0] === "") || b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

/**
 * The rules, grouped by how the gate uses them — Monitor (recorded, never
 * blocks), then the two stages it walks: Bot first (on the request), then
 * Suspicious (after the device checkpoint, in the browser) — each in its own
 * order, with what each one matched and blocked in the period (?range=), its
 * last 14 New York days and, last, the clicks that passed the gate. On top:
 * the spikes of today and yesterday and the gate per platform. ?q= searches
 * by name/reason, ?stage= shows one section, ?platform= one platform. Each
 * number opens those hits in the Logs.
 *
 * The numbers come from the hourly rollups (fast); the exact distinct IPs
 * (pages.rule_stats, slow) stream in afterwards, under Suspense.
 */
export default async function RulesPage({ searchParams }: { searchParams: Promise<{ platform?: string; range?: string; q?: string; stage?: string }> }) {
  // Dynamic Server Component: reading the clock per request is intentional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const { platform, range: rangeParam, q: qParam, stage: stageParam } = await searchParams;
  const range = parseRange(rangeParam);
  const since = resolveRange(range, nowMs).since;
  // The trend's 14 days plus the 7 before them, which only feed the first days' spike medians.
  const bounds = dayBounds(nowMs, TREND_DAYS + SPIKE_LOOKBACK);

  // Started now, awaited only by the "N unique" lines; a failure just leaves them out.
  const uniques: UniquesPromise = ruleStats(since).catch(() => null);
  const [all, totals, buckets, gate, seen] = await Promise.all([
    listRules(),
    ruleTotals(since),
    ruleBuckets(bounds.map((b) => new Date(b))),
    gateTotals(since),
    // The platforms the form offers: every one with clicks in the last 30 days, from the rollup (hit_platforms scans the hits).
    gateTotals(resolveRange("30d", nowMs).since),
  ]);
  const platformOptions = seen
    .filter((g) => g.platform !== "")
    .sort((a, b) => b.bot + b.suspicious + b.passed - (a.bot + a.suspicious + a.passed))
    .map((g) => g.platform);

  // One chip per platform, case-insensitive (a "Google" tag and a "google" scope are the same chip; the tag's spelling wins).
  const platforms = uniqueCaseless(all.flatMap((r) => [...r.tags, ...rulePlatforms(r.conditions)])).sort((a, b) => a.localeCompare(b));
  const selectedPlatform = typeof platform === "string" ? (platforms.find((p) => p.toLowerCase() === platform.toLowerCase()) ?? null) : null;
  const selectedKey = selectedPlatform?.toLowerCase() ?? null;
  const q = (qParam ?? "").trim();
  const stage = parseStage(stageParam);

  const needle = q.toLowerCase();
  const rules = all.filter((r) => {
    if (selectedKey && !rulePlatformKeys(r).includes(selectedKey)) return false;
    if (needle && !`${r.name} ${r.reason ?? ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const isBot = (r: Rule) => r.label.toLowerCase() === "bot";
  const monitor = rules.filter((r) => ruleMode(r) === "monitor");
  const walked = rules.filter((r) => ruleMode(r) !== "monitor");
  const bot = walked.filter(isBot);
  const suspicious = walked.filter((r) => !isBot(r));
  const showMonitor = (stage === null || stage === "monitor") && monitor.length > 0;
  const showBot = (stage === null || stage === "bot") && bot.length > 0;
  const showSuspicious = (stage === null || stage === "suspicious") && suspicious.length > 0;
  const filtered = selectedPlatform !== null || q !== "" || stage !== null;

  // Per rule and New York day: the trend (the last 14 days) and the spikes in it.
  const starts = bounds.slice(0, -1);
  const shownStarts = starts.slice(SPIKE_LOOKBACK);
  const trends: Trends = { starts: shownStarts, byRule: new Map() };
  const spikes: RuleSpike[] = [];
  for (const r of all) {
    const counts = buckets.get(r.id) ?? starts.map(() => 0);
    const found = findSpikes(counts, starts, Date.parse(r.created_at), SPIKE_LOOKBACK);
    trends.byRule.set(r.id, { values: counts.slice(SPIKE_LOOKBACK), spikes: new Set(found.map((s) => s.day - SPIKE_LOOKBACK)) });
    for (const s of found) spikes.push({ rule: r, start: starts[s.day], count: s.count, median: s.median });
  }
  const listed = new Set(rules.map((r) => r.id));

  // The Overlap of each stage: on the filter's platform, else the stage's biggest; one query per platform.
  const pairs = new Map<string, PairsPromise>();
  const overlapFor = (stageRules: Rule[]) => {
    const p = selectedKey ?? biggestPlatform(stageRules, totals);
    const key = p ?? "\u0000";
    if (!pairs.has(key)) pairs.set(key, rulePairs(since, p).catch(() => null));
    return { pairs: pairs.get(key)!, platform: p };
  };

  const passed = gate.reduce((n, g) => n + g.passed, 0);

  return (
    <>
      <PageHeader title="Rules" />

      <SpikeBanners spikes={spikes} today={starts[starts.length - 1]} yesterday={starts[starts.length - 2]} />

      <div className="mb-6">
        <RuleForm platformOptions={platformOptions} />
      </div>

      {all.length ? <RulesFilters range={range} platform={selectedPlatform} platforms={platforms} q={q} stage={stage} /> : null}

      <GateCard gate={gate} selected={selectedKey} rules={all} totals={totals} />

      {all.length ? <SpikesCard spikes={spikes.filter((s) => listed.has(s.rule.id))} /> : null}

      {!showMonitor && !showBot && !showSuspicious ? (
        <EmptyState
          title={filtered ? "No rules match" : "No rules"}
          description={filtered ? "Clear the filters to see every rule." : "Create the first rule above. With no rules, every click is clean and goes to the funnel of its sub1."}
        />
      ) : (
        <>
          {showMonitor ? <MonitorSection rules={monitor} totals={totals} gate={gate} trends={trends} platformOptions={platformOptions} /> : null}
          {showBot ? (
            <StageSection label="Bot" tone="danger" rules={bot} totals={totals} uniques={uniques} trends={trends} platformOptions={platformOptions} overlap={overlapFor(bot)} />
          ) : null}
          {showSuspicious ? (
            <StageSection
              label="Suspicious"
              tone="warning"
              rules={suspicious}
              totals={totals}
              uniques={uniques}
              trends={trends}
              platformOptions={platformOptions}
              overlap={overlapFor(suspicious)}
            />
          ) : null}

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
            <span className="text-sm font-medium">Passed</span>
            <Link href="/logs?funnel=sent" title="See them in the Logs" className="group sensitive inline-block text-right tabular-nums">
              <span className={`font-medium group-hover:underline ${passed ? "" : "text-muted"}`}>{num.format(passed)}</span>
              <Uniques stats={uniques} id={null} />
            </Link>
          </div>
        </>
      )}
    </>
  );
}
