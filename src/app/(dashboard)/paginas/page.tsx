import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { listPages } from "@/lib/pages/queries";
import { PAGE_KIND_LABELS, PAGE_STATUS_LABELS } from "@/lib/pages/types";
import { CreatePageForm } from "./create-page-form";

export const metadata: Metadata = {
  title: "Páginas",
};

const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export default async function PaginasPage() {
  const pages = await listPages();

  return (
    <>
      <PageHeader title="Páginas" description="Cada página tem um nome, um tipo e uma ou mais slugs com HTML. Os domínios apontam para elas." />

      <section className="mb-8 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Nova página</h2>
        <CreatePageForm />
      </section>

      {pages.length === 0 ? (
        <EmptyState title="Nenhuma página criada" description="Crie a primeira página acima. Ela nasce como rascunho com a slug /." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Nome</Th>
              <Th>Tipo</Th>
              <Th>Status</Th>
              <Th className="text-right">Slugs</Th>
              <Th className="text-right">Domínios</Th>
              <Th>Atualizada</Th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <Tr key={p.id}>
                <Td>
                  <Link href={`/paginas/${p.id}`} className="font-medium hover:text-accent">
                    {p.name}
                  </Link>
                </Td>
                <Td className="text-muted">{PAGE_KIND_LABELS[p.kind]}</Td>
                <Td>
                  <Badge tone={PAGE_STATUS_TONE[p.status]}>{PAGE_STATUS_LABELS[p.status]}</Badge>
                </Td>
                <Td className="text-right tabular-nums">{p.slugs_count}</Td>
                <Td className="text-right tabular-nums" title={`${p.domains_count} como página padrão · ${p.routes_count} por rota`}>
                  {p.domains_count + p.routes_count}
                </Td>
                <Td className="text-muted">{dateFmt.format(new Date(p.updated_at))}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
