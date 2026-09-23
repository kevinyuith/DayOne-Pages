import Link from "next/link";
import { AccessLogs } from "@/components/dashboard/access-logs";
import { AlertBanner } from "@/components/dashboard/alert-banner";
import { DashboardControls } from "@/components/dashboard/dashboard-controls";
import { FounderBadge } from "@/components/dashboard/founder-badge";
import { StatCard, type StatTone } from "@/components/dashboard/stat-card";
import { TrafficChart } from "@/components/dashboard/traffic-chart";
import { AccountIcon, BotIcon, GlobeIcon, PagesIcon, ShieldCheckIcon, ShieldXIcon } from "@/components/icons";
import { activeFilterCount, parseDashboardFilters, resolveRange } from "@/lib/pages/dashboard-filters";
import { countOverview, hitCountries, hitStats, hitTimeseries, listDomains, recentHits, type HitFilter } from "@/lib/pages/queries";

const num = new Intl.NumberFormat("en-US");
const pct = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)}% of total` : "—");

/**
 * Filtros na URL (ver dashboard-filters.ts): período, domínio, resultado,
 * dispositivo, país e bots. Cards, gráfico e Access Logs seguem todos eles;
 * o "Quick access" é cadastro, não tráfego, e não muda.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Server Component dinâmico (a rota é force-dynamic): ler o relógio por request é intencional.
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
  };
  const [counts, stats, series, hits, countries] = await Promise.all([
    countOverview(),
    hitStats(range.since, hitFilter),
    hitTimeseries(range.since, range.bucketMinutes, range.origin, hitFilter),
    recentHits(20, range.since, hitFilter),
    hitCountries(range.since, filters.domain),
  ]);

  const attentionCount = domains.filter((d) => d.status === "ACTIVE" && d.last_check_ok !== true).length;
  const domainOptions = domains.map((d) => ({ id: d.id, domain: d.domain }));
  const filtered = activeFilterCount(filters) > 0;

  // Os 5 cards, adaptados ao DayOne (sem "Gray Page"/cloaking), com dado real do período filtrado.
  const cards: { label: string; value: number; detail: string; icon: typeof GlobeIcon; tone: StatTone }[] = [
    { label: "Total Requests", value: stats.total, detail: range.label.toLowerCase(), icon: GlobeIcon, tone: "blue" },
    { label: "Served", value: stats.served, detail: pct(stats.served, stats.total), icon: ShieldCheckIcon, tone: "green" },
    { label: "Blocked", value: stats.blocked, detail: pct(stats.blocked, stats.total), icon: ShieldXIcon, tone: "red" },
    { label: "Unique Visitors", value: stats.uniques, detail: `by IP · ${range.short}`, icon: AccountIcon, tone: "amber" },
    { label: "Bots", value: stats.bots, detail: pct(stats.bots, stats.total), icon: BotIcon, tone: "purple" },
  ];

  const quickAccess = [
    { label: "Domains", value: counts.domains, detail: `${counts.domainsActive} active`, href: "/dominios", icon: GlobeIcon },
    { label: "Pages", value: counts.pages, detail: `${counts.pagesPublished} published`, href: "/paginas", icon: PagesIcon },
    { label: "Routes", value: counts.routes, detail: "path rules", href: "/dominios", icon: ShieldCheckIcon },
  ];

  return (
    <>
      <AlertBanner attentionCount={attentionCount} />

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Welcome <span className="text-accent">back</span>
          </h1>
          <p className="mt-1 text-sm text-muted">Manage your pages, domains and routing from one place.</p>
        </div>
        <FounderBadge />
      </header>

      <DashboardControls filters={filters} domains={domainOptions} countries={countries} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => (
          <StatCard key={c.label} label={c.label} value={num.format(c.value)} detail={c.detail} icon={c.icon} tone={c.tone} />
        ))}
      </div>

      <div className="mb-6">
        <TrafficChart buckets={series} granularity={range.granularity} periodLabel={range.label} />
      </div>

      <div className="mb-8">
        <AccessLogs hits={hits} filtered={filtered || filters.domain !== null} showDate={filters.range !== "today"} />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Quick access</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {quickAccess.map((s) => {
            const Icon = s.icon;
            return (
              <Link key={s.label} href={s.href} className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-muted">{s.label}</p>
                    <p className="mt-1 text-3xl font-semibold tabular-nums">
                      <span className="sensitive">{s.value}</span>
                    </p>
                    <p className="mt-1 text-xs text-muted">{s.detail}</p>
                  </div>
                  <span className="flex size-9 items-center justify-center rounded-lg bg-accent/10 text-accent transition-colors group-hover:bg-accent group-hover:text-accent-foreground">
                    <Icon className="size-[18px]" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </>
  );
}
