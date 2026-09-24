import type { Metadata } from "next";
import Link from "next/link";
import { isIP } from "node:net";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge, DOMAIN_STATUS_TONE } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { listDomains, listTemplates, unregisteredHosts } from "@/lib/pages/queries";
import { DOMAIN_STATUS_LABELS } from "@/lib/pages/types";
import { APP_TZ } from "@/lib/time-zone";
import { registerSeenDomain, removeDomain, setDomainStatus, verifyDomain } from "./actions";
import { DnsInstructions } from "./dns-instructions";
import { DomainForm } from "./domain-form";

export const metadata: Metadata = {
  title: "Domínios",
};

const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

/** Janela da lista "Vistos nos logs, sem cadastro". */
const SEEN_DAYS = 30;

export default async function DominiosPage() {
  // Server Component dinâmico (a rota é force-dynamic): ler o relógio por request é intencional.
  // eslint-disable-next-line react-hooks/purity
  const seenSince = new Date(Date.now() - SEEN_DAYS * 24 * 60 * 60 * 1000);
  const [domains, templates, seen] = await Promise.all([listDomains(), listTemplates(), unregisteredHosts(seenSince)]);
  // Só um IP de verdade vai para as instruções; qualquer outro texto na variável cai no aviso "defina SERVER_IP".
  const envIp = process.env.SERVER_IP?.trim() ?? "";
  const serverIp = isIP(envIp) ? envIp : "";

  return (
    <>
      <PageHeader title="Domínios" description="Cadastre o domínio, aponte o DNS pelo Cloudflare e escolha a página padrão. Rotas por path ficam no detalhe de cada domínio." />

      {/* `items-start`: o card do formulário fica na altura do conteúdo, sem esticar até o card de DNS. */}
      <div className="mb-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Adicionar domínio</h2>
          <DomainForm templates={templates} />
        </section>
        <DnsInstructions serverIp={serverIp} />
      </div>

      {seen.length > 0 ? (
        <section className="mb-8 rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Vistos nos logs, sem cadastro</h2>
          <p className="mt-1 text-xs text-muted">
            Hosts que chegaram ao servidor nos últimos {SEEN_DAYS} dias e não estão cadastrados (recebem 404). Cadastre os seus; os de
            terceiros (robôs testando o IP) podem ser ignorados.
          </p>
          <ul className="mt-3 divide-y divide-border/60">
            {seen.map((h) => (
              <li key={h.domain} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
                <div className="min-w-0">
                  <p className="break-all font-mono text-sm">{h.domain}</p>
                  <p className="text-xs text-muted">
                    {h.hits} {h.hits === 1 ? "hit" : "hits"}
                    {h.bots > 0 ? ` (${h.bots} de robô)` : ""} · último em {dateFmt.format(new Date(h.last_seen))}
                  </p>
                </div>
                <RowAction action={registerSeenDomain.bind(null, h.domain)} label="Cadastrar" pendingLabel="Cadastrando…" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {domains.length === 0 ? (
        <EmptyState title="Nenhum domínio cadastrado" description="Cadastre o primeiro domínio acima." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Domínio</Th>
              <Th>Status</Th>
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
