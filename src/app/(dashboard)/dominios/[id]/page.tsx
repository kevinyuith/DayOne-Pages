import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge, DOMAIN_STATUS_TONE } from "@/components/ui/badge";
import { getDomainDetail, listPageOptions } from "@/lib/pages/queries";
import { DOMAIN_STATUS_LABELS } from "@/lib/pages/types";
import { APP_TZ } from "@/lib/time-zone";
import { removeDomain, setDomainStatus, verifyDomain } from "../actions";
import { BotBlockToggle } from "./bot-block-toggle";
import { DefaultPageSelect } from "./default-page-select";
import { FilterPanel } from "./filter-panel";
import { RoutesPanel } from "./routes-panel";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const domain = await getDomainDetail(id);
  return { title: domain ? domain.domain : "Domínio" };
}

const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

export default async function DominioDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const [domain, pages] = await Promise.all([getDomainDetail(id), listPageOptions()]);
  if (!domain) notFound();

  return (
    <>
      <div className="mb-2">
        <Link href="/dominios" className="text-sm text-muted hover:text-foreground">
          ← Domínios
        </Link>
      </div>
      <PageHeader title={domain.domain} description="Rotas decidem o que cada path responde. Sem rota que case, vale a página padrão." />

      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={DOMAIN_STATUS_TONE[domain.status]}>{DOMAIN_STATUS_LABELS[domain.status]}</Badge>
            {domain.last_checked_at ? (
              <>
                <Badge tone={domain.last_check_ok ? "success" : "danger"}>{domain.last_check_ok ? "Servidor encontrado" : "Verificação falhou"}</Badge>
                <span className="text-xs text-muted">{dateFmt.format(new Date(domain.last_checked_at))}</span>
              </>
            ) : (
              <span className="text-xs text-muted">Nunca verificado</span>
            )}
          </div>
          {domain.last_check_error && !domain.last_check_ok ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{domain.last_check_error}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <RowAction action={verifyDomain.bind(null, domain.id)} label="Verificar DNS" pendingLabel="Verificando…" />
            {domain.status === "ACTIVE" ? (
              <RowAction action={setDomainStatus.bind(null, domain.id, "PAUSED")} label="Pausar" variant="ghost" />
            ) : (
              <RowAction action={setDomainStatus.bind(null, domain.id, "ACTIVE")} label="Ativar" variant="ghost" />
            )}
            <RowAction action={removeDomain.bind(null, domain.id)} label="Remover domínio" variant="danger" confirm={`Remover ${domain.domain} e todas as rotas?`} redirectTo="/dominios" />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Página padrão</h2>
          <p className="mt-1 text-xs text-muted">Servida quando nenhuma rota casa. O path da request vira a slug dessa página (`/` → slug `/`).</p>
          <div className="mt-3">
            <DefaultPageSelect domainId={domain.id} value={domain.default_page_id} pages={pages} />
          </div>
          {domain.default_page && domain.default_page.status !== "PUBLISHED" ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">A página padrão não está publicada e não será servida.</p>
          ) : null}
          {!domain.default_page_id ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Sem página padrão: paths sem rota respondem 404.</p> : null}
          {domain.filter && domain.filter_fail_page_id ? (
            <p className="mt-2 text-xs text-muted">Há um filtro ativo: quem não passa vê a página de reprovação, não esta.</p>
          ) : null}
        </div>
      </section>

      <section className="mb-6 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Segurança</h2>
        <p className="mt-1 text-xs text-muted">
          Bloqueia crawlers e conexões automatizadas (responde 403) antes de qualquer rota. Recomendado para tráfego de Google, Taboola, Outbrain e afins. Não troca a página — só barra.
        </p>
        <div className="mt-3">
          <BotBlockToggle domainId={domain.id} value={domain.block_bots} />
        </div>
      </section>

      <div className="mb-6">
        <FilterPanel domain={domain} pages={pages} />
      </div>

      <RoutesPanel domainId={domain.id} routes={domain.routes} pages={pages} />
    </>
  );
}
