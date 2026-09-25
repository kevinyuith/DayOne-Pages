import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge, DOMAIN_STATUS_TONE } from "@/components/ui/badge";
import { getDomainDetail, listTemplates } from "@/lib/pages/queries";
import { DOMAIN_STATUS_LABELS } from "@/lib/pages/types";
import { APP_TZ } from "@/lib/time-zone";
import { removeDomain, setDomainStatus, verifyDomain } from "../actions";
import { DomainPagesPanel } from "./domain-pages-panel";
import { DomainTypeSelect } from "./domain-type-select";
import { GateSlugsForm } from "./gate-slugs-form";
import { PlaceholdersForm } from "./placeholders-form";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const domain = await getDomainDetail(id);
  return { title: domain ? domain.domain : "Domain" };
}

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

export default async function DomainDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const [domain, templates] = await Promise.all([getDomainDetail(id), listTemplates()]);
  if (!domain) notFound();

  return (
    <>
      <div className="mb-2">
        <Link href="/domains" className="text-sm text-muted hover:text-foreground">
          ← Domains
        </Link>
      </div>
      <PageHeader title={domain.domain} />

      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={DOMAIN_STATUS_TONE[domain.status]}>{DOMAIN_STATUS_LABELS[domain.status]}</Badge>
            {domain.last_checked_at ? (
              <>
                <Badge tone={domain.last_check_ok ? "success" : "danger"}>{domain.last_check_ok ? "Server found" : "Verification failed"}</Badge>
                <span className="text-xs text-muted">{dateFmt.format(new Date(domain.last_checked_at))}</span>
              </>
            ) : (
              <span className="text-xs text-muted">Never verified</span>
            )}
          </div>
          {domain.last_check_error && !domain.last_check_ok ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{domain.last_check_error}</p>
          ) : null}
          <div className="mt-4">
            <DomainTypeSelect domainId={domain.id} value={domain.type} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <RowAction action={verifyDomain.bind(null, domain.id)} label="Verify DNS" pendingLabel="Verifying…" />
            {domain.status === "ACTIVE" ? (
              <RowAction action={setDomainStatus.bind(null, domain.id, "PAUSED")} label="Pause" variant="ghost" />
            ) : (
              <RowAction action={setDomainStatus.bind(null, domain.id, "ACTIVE")} label="Activate" variant="ghost" />
            )}
            <RowAction action={removeDomain.bind(null, domain.id)} label="Remove domain" variant="danger" confirm={`Remove ${domain.domain} and all its pages?`} redirectTo="/domains" />
          </div>
        </div>

        <GateSlugsForm domainId={domain.id} slugs={domain.gate_slugs} />
      </section>

      <div className="mb-6">
        <DomainPagesPanel domain={domain} templates={templates} />
      </div>

      <div className="mb-6">
        <PlaceholdersForm domainId={domain.id} domain={domain.domain} values={domain.placeholders} />
      </div>

    </>
  );
}
