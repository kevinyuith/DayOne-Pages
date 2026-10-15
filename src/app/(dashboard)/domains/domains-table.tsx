import Link from "next/link";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { DOMAIN_TYPE_LABELS, type Domain } from "@/lib/pages/types";
import { APP_TZ } from "@/lib/time-zone";
import { removeDomain, verifyDomain } from "./actions";
import { DomainStatusSelect } from "./domain-status-select";

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

/** The domains list of the Domains screen (and of the Vendor screen, with the VENDOR ones). */
export function DomainsTable({ domains }: { domains: Domain[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Domain</Th>
          <Th>Type</Th>
          <Th>Status</Th>
          <Th>Verification</Th>
          <Th className="text-right">Actions</Th>
        </tr>
      </thead>
      <tbody>
        {domains.map((d) => (
          <Tr key={d.id}>
            <Td>
              <Link href={`/domains/${d.id}`} className="font-medium hover:text-accent">
                {d.domain}
              </Link>
            </Td>
            <Td>{d.type ? DOMAIN_TYPE_LABELS[d.type] : <span className="text-muted">—</span>}</Td>
            <Td>
              <DomainStatusSelect domainId={d.id} value={d.status} verified={d.last_check_ok === true} showLabel={false} />
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
                <RowAction action={removeDomain.bind(null, d.id)} label="Remove" variant="danger" confirm={`Remove ${d.domain} and all its pages?`} />
              </div>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
