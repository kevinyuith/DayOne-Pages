import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import type { ScannedVersion } from "@/lib/pages/funnel-scan";
import { getFunnelDetail } from "@/lib/pages/queries";
import { PAGE_KINDS_SUB, SUB_KIND_LABELS, trafficShares } from "@/lib/pages/subpages";
import { PAGE_STATUS_LABELS } from "@/lib/pages/types";

type Params = Promise<{ id: string }>;

export const metadata: Metadata = {
  title: "Funnel page",
};

/** A funnel page: its steps and samples, and its copies on the domains (each with its own samples). */
export default async function FunnelPage({ params }: { params: Params }) {
  const { id } = await params;
  const detail = await getFunnelDetail(id);
  if (!detail) notFound();
  const { page, versions, copies } = detail;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href={page.mainFunnelId ? `/funnels?f=${page.mainFunnelId}` : "/funnels"} className="text-sm text-muted hover:text-foreground">
            ← Funnels
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {page.name} <Badge tone={PAGE_STATUS_TONE[page.status]}>{PAGE_STATUS_LABELS[page.status]}</Badge>
          </h1>
        </div>
        <Link href={`/funnels/${page.id}/edit`} className="inline-flex h-9 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90">
          Edit page and samples
        </Link>
      </div>

      <section className="mb-8 rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold">Steps and samples</h2>
        <StepsTable versions={versions} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">On domains</h2>
        {copies.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">No domain has this funnel yet.</p>
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
                  <Link href={`/domains/${c.domain_id}/pages/${c.page_id}?slug=${encodeURIComponent(c.slug)}`} className="text-xs text-accent hover:underline">
                    Adjust weights and samples →
                  </Link>
                </div>
                <StepsTable versions={c.versions} />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

/** Each step's samples and their share of the step's traffic. */
function StepsTable({ versions }: { versions: ScannedVersion[] }) {
  if (!versions.length) return <p className="text-sm text-muted">No steps: this slug is a single page (just the Lander).</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Step</th>
            <th className="py-1 pr-3 font-medium">Sample</th>
            <th className="py-1 pr-3 text-right font-medium">Traffic</th>
          </tr>
        </thead>
        <tbody>
          {PAGE_KINDS_SUB.map((kind) => {
            const mine = versions.filter((v) => v.kind === kind);
            if (!mine.length)
              return (
                <tr key={kind} className="border-t border-border text-muted">
                  <td className="py-1.5 pr-3">{SUB_KIND_LABELS[kind]}</td>
                  <td className="py-1.5 pr-3" colSpan={2}>
                    inactive
                  </td>
                </tr>
              );
            const shares = trafficShares(mine);
            return mine.map((v, i) => (
              <tr key={v.id} className={`border-t border-border ${v.active ? "" : "text-muted"}`}>
                <td className="py-1.5 pr-3">{i === 0 ? SUB_KIND_LABELS[kind] : ""}</td>
                <td className="py-1.5 pr-3">
                  {mine.length > 1 ? `Sample ${v.letter}` : "Only"}
                  {v.active ? null : <span className="ml-1 text-xs">(inactive)</span>}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{pct(shares.get(v.id) ?? 0)}</td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}
