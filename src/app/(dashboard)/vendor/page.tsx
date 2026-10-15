import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { listDomains, listTemplates } from "@/lib/pages/queries";
import { DomainForm } from "../domains/domain-form";
import { DomainsTable } from "../domains/domains-table";

export const metadata: Metadata = {
  title: "Vendor",
};

/** The Domains screen for the VENDOR domains: the ones that can serve vendor pages (scope VENDOR, src/lib/pages/vendor.ts). */
export default async function VendorPage() {
  const [domains, templates] = await Promise.all([listDomains("VENDOR"), listTemplates()]);

  return (
    <>
      <PageHeader title="Vendor" />

      <section className="mb-8 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Add domain</h2>
        <DomainForm templates={templates} type="VENDOR" />
      </section>

      {domains.length === 0 ? (
        <EmptyState title="No vendor domains" description="Add one above, or set a domain's type to Vendor." />
      ) : (
        <DomainsTable domains={domains} />
      )}
    </>
  );
}
