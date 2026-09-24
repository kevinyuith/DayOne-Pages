import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import type { ScannedVersion } from "@/lib/pages/funnel-scan";
import { getFunnelDetail, getPageWithSlugs, listDomains, type VersionStats } from "@/lib/pages/queries";
import { PAGE_KINDS_SUB, SUB_KIND_LABELS, trafficShares } from "@/lib/pages/subpages";
import { PAGE_STATUS_LABELS } from "@/lib/pages/types";
import { localMidnight } from "@/lib/time-zone";
import { CopyFunnelForm } from "./copy-funnel-form";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ dias?: string }>;

const PERIODS = [7, 30, 90] as const;
/** Abaixo disto a taxa ainda é ruído: não marca vencedora. */
const MIN_VIEWS_TO_RANK = 30;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const page = await getPageWithSlugs(id);
  return { title: page ? `Funnel: ${page.name}` : "Funnel" };
}

/**
 * Um funil da biblioteca: as etapas e amostras dele, e o teste A/B de cada
 * cópia nos domínios — visitantes únicos que viram cada amostra e que
 * clicaram para a próxima etapa ou para fora (a oferta). O período conta em
 * dias de Nova York, com hoje.
 */
export default async function FunnelPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, { dias }] = await Promise.all([params, searchParams]);
  const days = PERIODS.find((p) => String(p) === dias) ?? 30;
  // Server Component dinâmico (a rota é force-dynamic): ler o relógio por request é intencional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const since = new Date(localMidnight(nowMs, days - 1));
  const [detail, domains] = await Promise.all([getFunnelDetail(id, since), listDomains()]);
  if (!detail) notFound();
  if (detail.page.kind !== "FUNNEL") redirect(`/paginas/${id}`);
  const { page, versions, copies } = detail;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href={page.funnel_id ? `/funil?f=${page.funnel_id}` : "/funil"} className="text-sm text-muted hover:text-foreground">
            ← Funnels
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {page.name} <Badge tone={PAGE_STATUS_TONE[page.status]}>{PAGE_STATUS_LABELS[page.status]}</Badge>
          </h1>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Link href={`/paginas/${page.id}`} className="inline-flex h-9 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90">
            Edit funnel and samples
          </Link>
          <CopyFunnelForm funnelId={page.id} domains={domains.filter((d) => d.status !== "ARCHIVED").map((d) => ({ id: d.id, domain: d.domain }))} />
        </div>
      </div>

      <section className="mb-8 rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold">Steps and samples</h2>
        <StepsTable versions={versions} stats={null} />
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">A/B test on domains</h2>
          <nav className="flex gap-1 text-xs" aria-label="Period">
            {PERIODS.map((p) => (
              <Link
                key={p}
                href={`/funil/${page.id}?dias=${p}`}
                aria-current={p === days ? "page" : undefined}
                className={`rounded-md border px-2 py-1 ${p === days ? "border-accent/50 bg-accent/10 text-accent" : "border-border text-muted hover:text-foreground"}`}
              >
                {p} days
              </Link>
            ))}
          </nav>
        </div>
        {copies.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">No domain has this funnel yet. Copy it to a domain to start the test.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {copies.map((c) => (
              <div key={`${c.domain_id}:${c.page_id}`} className="rounded-xl border border-border bg-surface p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold">{c.domain}</span>
                    <span className="text-muted">
                      · {c.page_name} · <code>{c.slug}</code>
                    </span>
                    <Badge tone={PAGE_STATUS_TONE[c.status]}>{PAGE_STATUS_LABELS[c.status]}</Badge>
                  </div>
                  <Link href={`/dominios/${c.domain_id}/paginas/${c.page_id}?slug=${encodeURIComponent(c.slug)}`} className="text-xs text-accent hover:underline">
                    Adjust weights and samples →
                  </Link>
                </div>
                <StepsTable versions={c.versions} stats={c.stats} />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

/** As amostras de cada etapa: tráfego, e (numa cópia) visitas, cliques e taxa. */
function StepsTable({ versions, stats }: { versions: ScannedVersion[]; stats: Map<string, VersionStats> | null }) {
  if (!versions.length) return <p className="text-sm text-muted">No steps: this slug is a single page (just the Lander).</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Step</th>
            <th className="py-1 pr-3 font-medium">Sample</th>
            <th className="py-1 pr-3 text-right font-medium">Traffic</th>
            {stats ? (
              <>
                <th className="py-1 pr-3 text-right font-medium">Views</th>
                <th className="py-1 pr-3 text-right font-medium">Clicks</th>
                <th className="py-1 text-right font-medium">Rate</th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {PAGE_KINDS_SUB.map((kind) => {
            const mine = versions.filter((v) => v.kind === kind);
            if (!mine.length)
              return (
                <tr key={kind} className="border-t border-border text-muted">
                  <td className="py-1.5 pr-3">{SUB_KIND_LABELS[kind]}</td>
                  <td className="py-1.5 pr-3" colSpan={stats ? 5 : 2}>
                    inactive
                  </td>
                </tr>
              );
            const shares = trafficShares(mine);
            const rates = mine.map((v) => {
              const s = stats?.get(v.id);
              return s && s.views > 0 ? (s.clicks / s.views) * 100 : null;
            });
            const rankable = stats && mine.length > 1 && mine.every((v) => !v.active || (stats.get(v.id)?.views ?? 0) >= MIN_VIEWS_TO_RANK);
            const best = rankable ? Math.max(...rates.map((r) => r ?? -1)) : null;
            return mine.map((v, i) => {
              const s = stats?.get(v.id) ?? { views: 0, clicks: 0 };
              const winner = best !== null && best >= 0 && rates[i] === best;
              return (
                <tr key={v.id} className={`border-t border-border ${v.active ? "" : "text-muted"}`}>
                  <td className="py-1.5 pr-3">{i === 0 ? SUB_KIND_LABELS[kind] : ""}</td>
                  <td className="py-1.5 pr-3">
                    {mine.length > 1 ? `Sample ${v.letter}` : "Only"}
                    {v.active ? null : <span className="ml-1 text-xs">(inactive)</span>}
                    {winner ? <span className="ml-2 rounded bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">BEST RATE</span> : null}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{pct(shares.get(v.id) ?? 0)}</td>
                  {stats ? (
                    <>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.views.toLocaleString("en-US")}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.clicks.toLocaleString("en-US")}</td>
                      <td className="py-1.5 text-right tabular-nums">{rates[i] === null ? "—" : pct(rates[i] ?? 0)}</td>
                    </>
                  ) : null}
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}
