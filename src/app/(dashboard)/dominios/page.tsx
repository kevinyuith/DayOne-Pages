import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge, DOMAIN_STATUS_TONE } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { listDomains, listTemplates, unregisteredHosts } from "@/lib/pages/queries";
import { DOMAIN_STATUS_LABELS } from "@/lib/pages/types";
import { APP_TZ } from "@/lib/time-zone";
import { registerSeenDomain, removeDomain, setDomainStatus, verifyDomain } from "./actions";
import { DomainForm } from "./domain-form";

export const metadata: Metadata = {
  title: "Domains",
};

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

/** Janela da lista "Vistos nos logs, sem cadastro". */
const SEEN_DAYS = 30;

export default async function DominiosPage() {
  // Server Component dinâmico (a rota é force-dynamic): ler o relógio por request é intencional.
  // eslint-disable-next-line react-hooks/purity
  const seenSince = new Date(Date.now() - SEEN_DAYS * 24 * 60 * 60 * 1000);
  const [domains, templates, seen] = await Promise.all([listDomains(), listTemplates(), unregisteredHosts(seenSince)]);

  return (
    <>
      <PageHeader title="Domains" description="Register the domain and choose the template. Pages, company details and routes live on each domain's detail page." />

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
        <Table>
          <thead>
            <tr>
              <Th>Domain</Th>
              <Th>Status</Th>
              <Th>Verification</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {domains.map((d) => (
              <Tr key={d.id}>
                <Td>
                  <Link href={`/dominios/${d.id}`} className="font-medium hover:text-accent">
                    {d.domain}
                  </Link>
                </Td>
                <Td>
                  <Badge tone={DOMAIN_STATUS_TONE[d.status]}>{DOMAIN_STATUS_LABELS[d.status]}</Badge>
                </Td>
                <Td>
                  {d.last_checked_at ? (
                    <span className="inline-flex flex-col">
                      <Badge tone={d.last_check_ok ? "success" : "danger"}>{d.last_check_ok ? "OK" : "Failed"}</Badge>
                      <span className="mt-0.5 text-xs text-muted" title={d.last_check_error ?? undefined}>
                        {dateFmt.format(new Date(d.last_checked_at))}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted">never</span>
                  )}
                </Td>
                <Td className="text-right">
                  <div className="flex flex-wrap justify-end gap-1">
                    <RowAction action={verifyDomain.bind(null, d.id)} label="Verify" pendingLabel="Verifying…" />
                    {d.status === "ACTIVE" ? (
                      <RowAction action={setDomainStatus.bind(null, d.id, "PAUSED")} label="Pause" variant="ghost" />
                    ) : (
                      <RowAction action={setDomainStatus.bind(null, d.id, "ACTIVE")} label="Activate" variant="ghost" />
                    )}
                    <RowAction
                      action={removeDomain.bind(null, d.id)}
                      label="Remove"
                      variant="danger"
                      confirm={`Remove ${d.domain} and all its routes?`}
                    />
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
