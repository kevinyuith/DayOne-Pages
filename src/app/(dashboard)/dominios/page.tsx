import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge, DOMAIN_STATUS_TONE } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { listDomains, listPageOptions } from "@/lib/pages/queries";
import { DOMAIN_STATUS_LABELS, PAGE_KIND_LABELS } from "@/lib/pages/types";
import { removeDomain, setDomainStatus, verifyDomain } from "./actions";
import { DnsInstructions } from "./dns-instructions";
import { DomainForm } from "./domain-form";

export const metadata: Metadata = {
  title: "Domínios",
};

const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export default async function DominiosPage() {
  const [domains, pages] = await Promise.all([listDomains(), listPageOptions()]);
  const serverIp = process.env.SERVER_IP ?? "";

  return (
    <>
      <PageHeader title="Domínios" description="Cadastre o domínio, aponte o DNS pelo Cloudflare e escolha a página padrão. Rotas por path ficam no detalhe de cada domínio." />

      {/* `items-start`: o card do formulário fica na altura do conteúdo, sem esticar até o card de DNS. */}
      <div className="mb-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Adicionar domínio</h2>
          <DomainForm pages={pages} />
        </section>
        <DnsInstructions serverIp={serverIp} />
      </div>

      {domains.length === 0 ? (
        <EmptyState title="Nenhum domínio cadastrado" description="Cadastre o primeiro domínio acima." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Domínio</Th>
              <Th>Status</Th>
              <Th>Página padrão</Th>
              <Th className="text-right">Rotas</Th>
              <Th>Verificação</Th>
              <Th className="text-right">Ações</Th>
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
                  {d.default_page ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Link href={`/paginas/${d.default_page.id}`} className="hover:text-accent">
                        {d.default_page.name}
                      </Link>
                      <span className="text-xs text-muted">{PAGE_KIND_LABELS[d.default_page.kind]}</span>
                      {d.default_page.status !== "PUBLISHED" ? <Badge tone="warning">não publicada</Badge> : null}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{d.routes_count}</Td>
                <Td>
                  {d.last_checked_at ? (
                    <span className="inline-flex flex-col">
                      <Badge tone={d.last_check_ok ? "success" : "danger"}>{d.last_check_ok ? "OK" : "Falhou"}</Badge>
                      <span className="mt-0.5 text-xs text-muted" title={d.last_check_error ?? undefined}>
                        {dateFmt.format(new Date(d.last_checked_at))}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted">nunca</span>
                  )}
                </Td>
                <Td className="text-right">
                  <div className="flex flex-wrap justify-end gap-1">
                    <RowAction action={verifyDomain.bind(null, d.id)} label="Verificar" pendingLabel="Verificando…" />
                    {d.status === "ACTIVE" ? (
                      <RowAction action={setDomainStatus.bind(null, d.id, "PAUSED")} label="Pausar" variant="ghost" />
                    ) : (
                      <RowAction action={setDomainStatus.bind(null, d.id, "ACTIVE")} label="Ativar" variant="ghost" />
                    )}
                    <RowAction
                      action={removeDomain.bind(null, d.id)}
                      label="Remover"
                      variant="danger"
                      confirm={`Remover ${d.domain} e todas as rotas dele?`}
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
