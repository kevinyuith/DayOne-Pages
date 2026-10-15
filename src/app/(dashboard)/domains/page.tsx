import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { listDomains, listTemplates, unregisteredHosts } from "@/lib/pages/queries";
import { APP_TZ } from "@/lib/time-zone";
import { registerSeenDomain } from "./actions";
import { DomainForm } from "./domain-form";
import { DomainsTable } from "./domains-table";

export const metadata: Metadata = {
  title: "Domains",
};

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

/** Window for the "Seen in the logs, not registered" list. */
const SEEN_DAYS = 30;

export default async function DomainsPage() {
  // Dynamic Server Component (the route is force-dynamic): reading the clock per request is intentional.
  // eslint-disable-next-line react-hooks/purity
  const seenSince = new Date(Date.now() - SEEN_DAYS * 24 * 60 * 60 * 1000);
  const [domains, templates, seen] = await Promise.all([listDomains(), listTemplates(), unregisteredHosts(seenSince)]);

  return (
    <>
      <PageHeader title="Domains" />

      <section className="mb-8 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Add domain</h2>
        <DomainForm templates={templates} />
      </section>

      {seen.length > 0 ? (
        <section className="mb-8 rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Seen in the logs, not registered</h2>
          <p className="mt-1 text-xs text-muted">
            Hosts that reached the server in the last {SEEN_DAYS} days and aren&apos;t registered (they get a 404). Register yours; third-party
            ones (bots probing the IP) can be ignored.
          </p>
          <ul className="mt-3 divide-y divide-border/60">
            {seen.map((h) => (
              <li key={h.domain} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
                <div className="min-w-0">
                  <p className="break-all font-mono text-sm">{h.domain}</p>
                  <p className="text-xs text-muted">
                    {h.hits} {h.hits === 1 ? "hit" : "hits"}
                    {h.bots > 0 ? ` (${h.bots} from bots)` : ""} · last seen {dateFmt.format(new Date(h.last_seen))}
                  </p>
                </div>
                <RowAction action={registerSeenDomain.bind(null, h.domain)} label="Register" pendingLabel="Registering…" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {domains.length === 0 ? (
        <EmptyState title="No domains registered" description="Register your first domain above." />
      ) : (
        <DomainsTable domains={domains} />
      )}
    </>
  );
}
