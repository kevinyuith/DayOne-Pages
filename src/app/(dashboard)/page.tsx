import Link from "next/link";
import { AccessLogs } from "@/components/dashboard/access-logs";
import { AlertBanner } from "@/components/dashboard/alert-banner";
import { DashboardControls } from "@/components/dashboard/dashboard-controls";
import { FounderBadge } from "@/components/dashboard/founder-badge";
import { StatCard, type StatTone } from "@/components/dashboard/stat-card";
import { TrafficChart } from "@/components/dashboard/traffic-chart";
import {
  AccountIcon,
  BotIcon,
  GlobeIcon,
  PagesIcon,
  ShieldCheckIcon,
  ShieldXIcon,
} from "@/components/icons";
import { countOverview, listDomains } from "@/lib/pages/queries";

// Os 5 cards de tráfego mapeiam 1:1 os do layout de referência, adaptados ao
// DayOne (sem "Gray Page", que é cloaking). Todos "soon": ainda não há coleta.
const TRAFFIC_CARDS: { label: string; icon: typeof GlobeIcon; tone: StatTone }[] = [
  { label: "Total Requests", icon: GlobeIcon, tone: "blue" },
  { label: "Served", icon: ShieldCheckIcon, tone: "green" },
  { label: "Blocked", icon: ShieldXIcon, tone: "red" },
  { label: "Unique Visitors", icon: AccountIcon, tone: "amber" },
  { label: "Bots Blocked", icon: BotIcon, tone: "purple" },
];

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export default async function DashboardPage() {
  const [counts, domains] = await Promise.all([countOverview(), listDomains()]);

  // Sinal real para o banner: domínios ativos que ainda não verificaram o DNS.
  const attentionCount = domains.filter((d) => d.status === "ACTIVE" && d.last_check_ok !== true).length;
  const domainNames = domains.map((d) => d.domain);

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

      <DashboardControls dateLabel={dateFmt.format(new Date())} domains={domainNames} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {TRAFFIC_CARDS.map((c) => (
          <StatCard key={c.label} label={c.label} icon={c.icon} tone={c.tone} soon />
        ))}
      </div>

      <div className="mb-6">
        <TrafficChart />
      </div>

      <div className="mb-8">
        <AccessLogs />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Quick access</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {quickAccess.map((s) => {
            const Icon = s.icon;
            return (
              <Link
                key={s.label}
                href={s.href}
                className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent"
              >
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
