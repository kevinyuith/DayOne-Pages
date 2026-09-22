import type { Metadata } from "next";
import Link from "next/link";
import { OUTCOME_BADGE } from "@/components/dashboard/access-logs";
import { EmptyState } from "@/components/empty-state";
import { ChevronDownIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { connectionType } from "@/lib/connection";
import { ipv6Prefix64 } from "@/lib/net";
import { browserFromUA } from "@/lib/user-agent";
import { listDomains, listHits } from "@/lib/pages/queries";

export const metadata: Metadata = {
  title: "Logs",
};

const PAGE_SIZE = 100;

const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" });

/**
 * Cada request registrado em pages.hits, com todas as colunas, do mais novo
 * para o mais antigo. Filtro por domínio (?domain=<id>, form GET, sem JS) e
 * paginação por cursor (?before=<id>).
 */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { domain, before } = await searchParams;
  const domains = await listDomains();
  const selected = typeof domain === "string" && domains.some((d) => d.id === domain) ? domain : null;
  const beforeId = typeof before === "string" && /^\d+$/.test(before) ? Number(before) : null;
  const { rows: hits, hasMore } = await listHits({ domainId: selected, beforeId, limit: PAGE_SIZE });

  const pageHref = (cursor: number | null) => {
    const qs = new URLSearchParams();
    if (selected) qs.set("domain", selected);
    if (cursor) qs.set("before", String(cursor));
    const s = qs.toString();
    return s ? `/logs?${s}` : "/logs";
  };

  return (
    <>
      <PageHeader title="Logs" description="Cada request servido, com tudo o que foi registrado, do mais novo para o mais antigo." />

      <form method="get" className="mb-6 flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Domínio</span>
          <select
            name="domain"
            defaultValue={selected ?? ""}
            className="appearance-none rounded-lg border border-border bg-surface py-2 pl-3 pr-9 text-sm font-medium text-muted transition-colors hover:text-foreground"
          >
            <option value="">Todos os domínios</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.domain}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        </label>
        <Button type="submit" variant="secondary">
          Filtrar
        </Button>
      </form>

      {hits.length === 0 ? (
        <EmptyState
          title={beforeId ? "Não há requests mais antigos" : "Nenhum request registrado"}
          description="Os requests aparecem aqui conforme o servidor de entrega os registra."
        />
      ) : (
        <Table className="min-w-[2900px]">
          <thead>
            <tr>
              <Th>Data</Th>
              <Th>Request</Th>
              <Th>Domínio</Th>
              <Th>Slug</Th>
              <Th>Decisão</Th>
              <Th className="text-right">Status</Th>
              <Th>Resultado</Th>
              <Th>País</Th>
              <Th>Estado</Th>
              <Th>Dispositivo</Th>
              <Th>Navegador</Th>
              <Th>Referrer</Th>
              <Th>IP</Th>
              <Th title="Primeiros 64 bits do IPv6: iguais para a mesma conexão, mesmo quando o final do IP muda">Rede IPv6</Th>
              <Th>Hostname</Th>
              <Th>ASN</Th>
              <Th title="Estimada pelo ASN (aproximada). O servidor não distingue WiFi de cabo.">Conexão</Th>
              <Th>User-Agent</Th>
              <Th>Cookies</Th>
            </tr>
          </thead>
          <tbody className="sensitive">
            {hits.map((h) => {
              const o = OUTCOME_BADGE[h.outcome] ?? OUTCOME_BADGE.other;
              const net = ipv6Prefix64(h.ip);
              return (
                <Tr key={h.id}>
                  <Td className="whitespace-nowrap tabular-nums text-muted" title={`#${h.id}`}>
                    {dateFmt.format(new Date(h.created_at))}
                  </Td>
                  <Td className="max-w-[280px] break-all">
                    <span className="font-mono text-xs">{h.host}</span>
                    <span className="font-mono text-xs text-muted">{h.path}</span>
                  </Td>
                  <Td className="max-w-[220px] break-all font-mono text-xs text-muted">{h.domain || "—"}</Td>
                  <Td className="min-w-[120px] max-w-[220px] text-xs text-muted">
                    {h.slug ? (
                      <>
                        <span className="break-all font-mono text-foreground">{h.slug}</span>
                        {h.page_name ? (
                          <span className="block truncate" title={h.page_name}>
                            {h.page_name}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs text-muted" title={h.route_id ? `rota ${h.route_id}` : undefined}>
                    {h.decision || "—"}
                  </Td>
                  <Td className="text-right tabular-nums text-muted">{h.status_code ?? "—"}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone={o.tone}>{o.label}</Badge>
                      {h.is_bot ? <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">bot</span> : null}
                    </span>
                  </Td>
                  <Td className="text-muted">{h.country || "—"}</Td>
                  <Td className="whitespace-nowrap text-muted">{h.region || "—"}</Td>
                  <Td className="text-muted">{h.device || "—"}</Td>
                  <Td className="whitespace-nowrap text-muted">{browserFromUA(h.user_agent) ?? "—"}</Td>
                  <Td className="max-w-[180px] break-all text-muted">{h.referrer_host || "—"}</Td>
                  <Td className="whitespace-nowrap font-mono text-xs text-muted">{h.ip || "—"}</Td>
                  <Td className="whitespace-nowrap font-mono text-xs text-muted">{net ? `${net}::/64` : "—"}</Td>
                  <Td className="max-w-[220px] break-all font-mono text-xs text-muted">{h.hostname || "—"}</Td>
                  <Td className="min-w-[160px] max-w-[240px] text-xs text-muted">
                    {h.asn ? (
                      <>
                        <span className="font-mono text-foreground">AS{h.asn}</span>
                        {h.as_name ? (
                          <span className="block truncate" title={h.as_name}>
                            {h.as_name}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{connectionType(h.asn, h.as_name) ?? "—"}</Td>
                  <Td className="min-w-[280px] max-w-[420px] break-all font-mono text-[11px] leading-snug text-muted">{h.user_agent || "—"}</Td>
                  <Td className="min-w-[240px] max-w-[360px] font-mono text-[11px] leading-snug text-muted">
                    {h.cookies ? (
                      <span className="line-clamp-3 break-all" title={h.cookies}>
                        {h.cookies}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {beforeId || hasMore ? (
        <nav className="mt-4 flex items-center justify-between text-sm">
          {beforeId ? (
            <Link href={pageHref(null)} className="font-medium text-muted hover:text-foreground">
              ← Mais recentes
            </Link>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Link href={pageHref(hits[hits.length - 1].id)} className="font-medium text-muted hover:text-foreground">
              Mais antigos →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
