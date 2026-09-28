import { AccessLogs } from "@/components/dashboard/access-logs";
import { AlertBanner } from "@/components/dashboard/alert-banner";
import { DashboardControls } from "@/components/dashboard/dashboard-controls";
import { StatStrip, type Stat } from "@/components/dashboard/stat-card";
import { TrafficChart } from "@/components/dashboard/traffic-chart";
import { activeFilterCount, bucketEdges, parseDashboardFilters, platformLabel, resolveRange } from "@/lib/pages/dashboard-filters";
import { hitCountries, hitPlatforms, hitSeries, hitStats, listDomains, recentHits, type HitFilter } from "@/lib/pages/queries";

const num = new Intl.NumberFormat("en-US");

/** Fraction and "N% of requests" text (with "<1%" so something that exists never shows as 0%). */
function share(part: number, total: number, noun = "of requests"): { share: number; detail: string } {
  if (total <= 0) return { share: 0, detail: "—" };
  const f = part / total;
  const p = Math.round(f * 100);
  return { share: f, detail: `${part > 0 && p === 0 ? "<1" : p}% ${noun}` };
}

/**
 * Filters in the URL (see dashboard-filters.ts): period, domain, platform
 * (the sub11), outcome, device, country and bots. The cards (total requests and the unique-visitor
 * counts), the chart and the table all follow them.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Dynamic Server Component (the route is force-dynamic): reading the clock per request is intentional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [sp, domains] = await Promise.all([searchParams, listDomains()]);
  const filters = parseDashboardFilters(sp, domains.map((d) => d.id));
  const range = resolveRange(filters.range, nowMs);
  const hitFilter: HitFilter = {
    domainId: filters.domain,
    outcomes: filters.outcomes,
    devices: filters.devices,
    countries: filters.countries,
    hideBots: filters.hideBots,
    platform: filters.platform,
  };
  const [stats, series, hits, countries, platforms] = await Promise.all([
    hitStats(range.since, hitFilter),
    hitSeries(bucketEdges(range, nowMs), hitFilter),
    recentHits(20, range.since, hitFilter),
    hitCountries(range.since, filters.domain),
    hitPlatforms(range.since, filters.domain),
  ]);

  const attentionCount = domains.filter((d) => d.status === "ACTIVE" && d.last_check_ok !== true).length;
  const domainOptions = domains.map((d) => ({ id: d.id, domain: d.domain }));
  const filtered = activeFilterCount(filters) > 0;
  const scope = domains.find((d) => d.id === filters.domain)?.domain;

  // The 5 numbers for the filtered period. Total is every request; the rest are UNIQUE visitors
  // (distinct IPs): the ones that got a 200, the ones a rule caught as a bot or as suspicious, and the
  // ones whose page loaded — over the ones that passed the gate, the connect rate. They overlap (a bot
  // can have loaded), so they aren't parts of a whole.
  const stats5: Stat[] = [
    { label: "Total requests", value: num.format(stats.total), detail: range.label },
    { label: "Unique visitors", value: num.format(stats.uniques), detail: "Distinct IPs · 200" },
    { label: "Bots (Unique)", value: num.format(stats.botsUnique), series: "bots", ...share(stats.botsUnique, stats.uniques, "of visitors") },
    { label: "Suspicious (Unique)", value: num.format(stats.suspiciousUnique), series: "suspicious", ...share(stats.suspiciousUnique, stats.uniques, "of visitors") },
    {
      label: "Loaded (Unique)",
      value: num.format(stats.loadedUnique),
      series: "loaded",
      ...share(stats.loadedUnique, stats.gateUnique, `connect rate · ${num.format(stats.gateUnique)} passed`),
    },
  ];

  return (
    <>
      <AlertBanner attentionCount={attentionCount} />

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Traffic {scope ? <>on <span className="font-medium text-foreground">{scope}</span></> : "across all domains"}
          {filters.platform ? <> from <span className="font-medium text-foreground">{platformLabel(filters.platform)}</span></> : null} ·{" "}
          {range.label.toLowerCase()}
        </p>
      </header>

      <DashboardControls filters={filters} domains={domainOptions} countries={countries} platforms={platforms} />

      <div data-dash-content className="space-y-6">
        <StatStrip stats={stats5} />
        <TrafficChart buckets={series} granularity={range.granularity} periodLabel={range.label} />
        <AccessLogs hits={hits} filtered={filtered || filters.domain !== null || filters.platform !== null} showDate={filters.range !== "today"} />
      </div>

    </>
  );
}
