import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { listUpsellFunnels } from "@/lib/pages/upsell";
import { VENDOR_PLATFORM_LABELS, isVendorPlatform } from "@/lib/pages/types";
import { APP_TZ } from "@/lib/time-zone";
import { NewUpsellFunnel } from "./new-upsell-funnel";

export const metadata: Metadata = {
  title: "Upsells",
};

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

/** The vendor pages' upsell funnels: Upsell 1…5 and the Thank you page after the checkout. */
export default async function UpsellsPage() {
  const { funnels, freePages } = await listUpsellFunnels();

  return (
    <>
      <PageHeader title="Upsells" />

      <section className="mb-8 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">New upsell funnel</h2>
        <NewUpsellFunnel pages={freePages} />
      </section>

      {funnels.length === 0 ? (
        <EmptyState title="No upsell funnels" description="Create one above from a vendor page." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Funnel</Th>
              <Th>Vendor page</Th>
              <Th>Platform</Th>
              <Th>Domain</Th>
              <Th>Steps</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {funnels.map((f) => (
              <Tr key={f.id}>
                <Td>
                  <Link href={`/upsells/${f.id}`} className="font-medium hover:text-accent">
                    {f.name}
                  </Link>
                </Td>
                <Td>{f.pageName}</Td>
                <Td>{f.platform && isVendorPlatform(f.platform) ? VENDOR_PLATFORM_LABELS[f.platform] : <span className="text-muted">—</span>}</Td>
                <Td>{f.domains.length ? f.domains.join(", ") : <span className="text-muted">not on a domain</span>}</Td>
                <Td>{f.steps}</Td>
                <Td>
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {f.liveAt ? <Badge tone="success">Live</Badge> : <Badge tone="neutral">Not published</Badge>}
                    {f.hasDraft ? <Badge tone="warning">Unpublished changes</Badge> : null}
                    {f.liveAt ? <span className="text-xs text-muted">since {dateFmt.format(new Date(f.liveAt))}</span> : null}
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
