import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getFunnelBoard, listDomains, listTemplates } from "@/lib/pages/queries";
import { localMidnight } from "@/lib/time-zone";
import { FunnelList } from "./funnel-list";

export const metadata: Metadata = {
  title: "Funnel",
};

const PERIODS = [7, 30, 90] as const;

/**
 * The dayone-main funnels (F1, F2…) as a list. Each funnel opens in two tabs:
 * Pages (its pages in pages.funnels and the A/B test between them) and VSLs
 * (its VTurb A/B test, loaded when the tab opens). `?days=` picks the Pages
 * period (New York days, including today); `?f=<id>` opens a funnel (back from
 * the editor).
 */
export default async function FunnelsPage({ searchParams }: { searchParams: Promise<{ days?: string; f?: string }> }) {
  const { days: rawDays, f } = await searchParams;
  const days = PERIODS.find((p) => String(p) === rawDays) ?? 30;
  // Dynamic Server Component (the route is force-dynamic): reading the clock per request is intentional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [board, templates, domains] = await Promise.all([getFunnelBoard(new Date(localMidnight(nowMs, days - 1))), listTemplates(), listDomains()]);

  return (
    <>
      <PageHeader title="Funnel" />
      <FunnelList
        rows={board.rows}
        stats={board.stats}
        templates={templates}
        domains={domains.map((d) => ({ id: d.id, domain: d.domain }))}
        days={days}
        initialOpen={f ?? null}
      />
    </>
  );
}
