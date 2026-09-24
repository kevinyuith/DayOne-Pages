import Link from "next/link";
import { AccessLogs } from "@/components/dashboard/access-logs";
import { AlertBanner } from "@/components/dashboard/alert-banner";
import { DashboardControls } from "@/components/dashboard/dashboard-controls";
import { StatStrip, type Stat } from "@/components/dashboard/stat-card";
import { TrafficChart } from "@/components/dashboard/traffic-chart";
import { ChevronRightIcon } from "@/components/icons";
import { activeFilterCount, foldIntoLocalDays, parseDashboardFilters, resolveRange } from "@/lib/pages/dashboard-filters";
import { countOverview, hitCountries, hitStats, hitTimeseries, listDomains, recentHits, type HitFilter } from "@/lib/pages/queries";

const num = new Intl.NumberFormat("en-US");

/** Fração e texto "N% of requests" (com "<1%" para não mostrar 0% de algo que existe). */
function share(part: number, total: number): { share: number; detail: string } {
  if (total <= 0) return { share: 0, detail: "—" };
  const f = part / total;
  const p = Math.round(f * 100);
  return { share: f, detail: `${part > 0 && p === 0 ? "<1" : p}% of requests` };
}

/**
 * Filtros na URL (ver dashboard-filters.ts): período, domínio, resultado,
 * dispositivo, país e bots. Cards, gráfico e a tabela seguem todos eles;
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
  const [counts, stats, hourly, hits, countries] = await Promise.all([
    countOverview(),
    hitStats(range.since, hitFilter),
    hitTimeseries(range.since, range.bucketMinutes, range.origin, hitFilter),
    recentHits(20, range.since, hitFilter),
    hitCountries(range.since, filters.domain),
  ]);
  const series = range.granularity === "day" ? foldIntoLocalDays(hourly) : hourly;

  const attentionCount = domains.filter((d) => d.status === "ACTIVE" && d.last_check_ok !== true).length;
  const domainOptions = domains.map((d) => ({ id: d.id, domain: d.domain }));
  const filtered = activeFilterCount(filters) > 0;
  const scope = domains.find((d) => d.id === filters.domain)?.domain;

  // Os 5 números do período filtrado. Served/Blocked/Bots são as séries do gráfico (mesma cor);
  // Bots cruza os outros (um bot pode ser servido), então as frações não somam 100%.
  const stats5: Stat[] = [
    { label: "Total requests", value: num.format(stats.total), detail: range.label },
    { label: "Served", value: num.format(stats.served), series: "served", ...share(stats.served, stats.total) },
    { label: "Blocked", value: num.format(stats.blocked), series: "blocked", ...share(stats.blocked, stats.total) },
    { label: "Unique visitors", value: num.format(stats.uniques), detail: "Distinct IPs" },
    { label: "Bots", value: num.format(stats.bots), series: "bots", ...share(stats.bots, stats.total) },
  ];

  const quickAccess = [
    { label: "Domains", value: counts.domains, detail: `${counts.domainsActive} active`, href: "/dominios" },
    { label: "Page templates", value: counts.pages, detail: `${counts.domainPages} copied to domains`, href: "/paginas" },
    { label: "Routes", value: counts.routes, detail: "Path rules", href: "/dominios" },
  ];

  return (
    <>
      <AlertBanner attentionCount={attentionCount} />

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Traffic {scope ? <>on <span className="font-medium text-foreground">{scope}</span></> : "across all domains"} · {range.label.toLowerCase()}
        </p>
      </header>

      <DashboardControls filters={filters} domains={domainOptions} countries={countries} />

      <div data-dash-content className="space-y-6">
        <StatStrip stats={stats5} />
        <TrafficChart buckets={series} granularity={range.granularity} periodLabel={range.label} />
        <AccessLogs hits={hits} filtered={filtered || filters.domain !== null} showDate={filters.range !== "today"} />
      </div>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium text-muted">Quick access</h2>
        <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          {quickAccess.map((s) => (
            <Link key={s.label} href={s.href} className="group flex items-center justify-between gap-3 bg-surface px-5 py-4 transition-colors hover:bg-foreground/[0.03]">
              <div className="min-w-0">
                <p className="text-sm text-muted">{s.label}</p>
                <p className="mt-1 text-2xl font-semibold tracking-tight">
                  <span className="sensitive">{num.format(s.value)}</span>
                </p>
                <p className="mt-0.5 truncate text-xs text-muted">{s.detail}</p>
              </div>
              <ChevronRightIcon className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
