import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getFunnelBoard, listTemplates } from "@/lib/pages/queries";
import { localMidnight } from "@/lib/time-zone";
import { FunnelList } from "./funnel-list";

export const metadata: Metadata = {
  title: "Funnel",
};

const PERIODS = [7, 30, 90] as const;

/**
 * Os funis do dayone-main (F1, F2…) em lista, cada um com as páginas dele
 * (pages.funnel_id) e o teste A/B das amostras. `?days=` escolhe o período
 * (dias de Nova York, com hoje); `?f=<id>` abre um funil (volta do editor).
 */
export default async function FunilPage({ searchParams }: { searchParams: Promise<{ days?: string; f?: string }> }) {
  const { days: rawDays, f } = await searchParams;
  const days = PERIODS.find((p) => String(p) === rawDays) ?? 30;
  // Server Component dinâmico (a rota é force-dynamic): ler o relógio por request é intencional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [board, templates] = await Promise.all([getFunnelBoard(new Date(localMidnight(nowMs, days - 1))), listTemplates()]);

  return (
    <>
      <PageHeader
        title="Funnel"
        description="The dayone-main funnels (F1, F2…). Open one to see its pages: each step (Pre Lander → Lander → Backredirect) can have samples for an A/B test, with traffic, views and clicks. Click a sample to edit it."
      />
      <FunnelList
        rows={board.rows}
        stats={board.stats}
        templates={templates.filter((t) => t.kind !== "FUNNEL").map((t) => ({ id: t.id, name: t.name }))}
        days={days}
        initialOpen={f ?? null}
      />
    </>
  );
}
