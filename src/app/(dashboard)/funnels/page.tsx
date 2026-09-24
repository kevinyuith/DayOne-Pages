import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getFunnelBoard, getFunnelVsls, listDomains, listTemplates } from "@/lib/pages/queries";
import { localMidnight } from "@/lib/time-zone";
import { FunnelList } from "./funnel-list";
import { VslList } from "./vsl-list";

export const metadata: Metadata = {
  title: "Funnel",
};

const PERIODS = [7, 30, 90] as const;
const TABS = [
  { key: "pages", label: "Pages" },
  { key: "vsls", label: "VSLs" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/**
 * The dayone-main funnels (F1, F2…) as a list, in two tabs: Pages (each
 * funnel's pages in pages.funnels and the A/B test between them) and VSLs
 * (the VSLs linked to each funnel in dayone-main, read-only). `?tab=` picks
 * the tab; `?days=` the Pages period (New York days, including today);
 * `?f=<id>` opens a funnel (back from the editor).
 */
export default async function FunnelsPage({ searchParams }: { searchParams: Promise<{ tab?: string; days?: string; f?: string }> }) {
  const { tab: rawTab, days: rawDays, f } = await searchParams;
  const tab: Tab = rawTab === "vsls" ? "vsls" : "pages";

  return (
    <>
      <PageHeader title="Funnel" />
      <nav className="mb-4 flex gap-1 border-b border-border" aria-label="Funnel tabs">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "pages" ? "/funnels" : `/funnels?tab=${t.key}`}
            aria-current={t.key === tab ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              t.key === tab ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "vsls" ? <VslsTab initialOpen={f ?? null} /> : <PagesTab rawDays={rawDays} initialOpen={f ?? null} />}
    </>
  );
}

async function PagesTab({ rawDays, initialOpen }: { rawDays: string | undefined; initialOpen: string | null }) {
  const days = PERIODS.find((p) => String(p) === rawDays) ?? 30;
  // Dynamic Server Component (the route is force-dynamic): reading the clock per request is intentional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [board, templates, domains] = await Promise.all([getFunnelBoard(new Date(localMidnight(nowMs, days - 1))), listTemplates(), listDomains()]);
  return (
    <FunnelList
      rows={board.rows}
      stats={board.stats}
      templates={templates}
      domains={domains.filter((d) => d.status !== "ARCHIVED").map((d) => ({ id: d.id, domain: d.domain }))}
      days={days}
      initialOpen={initialOpen}
    />
  );
}

async function VslsTab({ initialOpen }: { initialOpen: string | null }) {
  const rows = await getFunnelVsls();
  return <VslList rows={rows} initialOpen={initialOpen} />;
}
