"use client";

import Link from "next/link";
import { useState } from "react";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { summarizeConditions } from "@/lib/pages/conditions";
import type { DomainRouteWithPage, PageOption } from "@/lib/pages/queries";
import { MATCH_TYPE_LABELS, PAGE_KIND_LABELS } from "@/lib/pages/types";
import { deleteRoute, moveRoute, toggleRoute } from "../actions";
import { RouteForm } from "./route-form";

/**
 * Tabela de rotas + formulário (nova / editar). O estado "qual rota está em
 * edição" é só de tela; os dados vêm do servidor a cada revalidação.
 */
export function RoutesPanel({ domainId, routes, pages }: { domainId: string; routes: DomainRouteWithPage[]; pages: PageOption[] }) {
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const editingRoute = typeof editing === "string" && editing !== "new" ? routes.find((r) => r.id === editing) ?? null : null;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Rotas</h2>
        <Button size="sm" onClick={() => setEditing(editing === "new" ? null : "new")}>
          {editing === "new" ? "Cancelar" : "Nova rota"}
        </Button>
      </div>

      {editing === "new" ? (
        <div className="mb-4">
          <RouteForm domainId={domainId} pages={pages} route={null} nextPriority={nextPriority(routes)} onDone={() => setEditing(null)} />
        </div>
      ) : null}

      {routes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-surface px-6 py-10 text-center text-sm text-muted">
          Nenhuma rota. Todo path cai na página padrão.
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-12 text-right">#</Th>
              <Th>Rota</Th>
              <Th>Path</Th>
              <Th>Condições</Th>
              <Th>Ação</Th>
              <Th className="text-right">Ações</Th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <RouteRow key={r.id} route={r} domainId={domainId} editing={editing === r.id} onEdit={() => setEditing(editing === r.id ? null : r.id)} />
            ))}
          </tbody>
        </Table>
      )}

      {editingRoute ? (
        <div className="mt-4">
          <RouteForm domainId={domainId} pages={pages} route={editingRoute} nextPriority={editingRoute.priority} onDone={() => setEditing(null)} />
        </div>
      ) : null}
    </section>
  );
}

function nextPriority(routes: DomainRouteWithPage[]): number {
  const max = routes.reduce((m, r) => Math.max(m, r.priority), 0);
  return routes.length === 0 ? 100 : max + 10;
}

function RouteRow({
  route: r,
  domainId,
  editing,
  onEdit,
}: {
  route: DomainRouteWithPage;
  domainId: string;
  editing: boolean;
  onEdit: () => void;
}) {
  return (
    <Tr className={[r.is_active ? "" : "opacity-60", editing ? "bg-accent/5" : ""].join(" ")}>
      <Td className="text-right tabular-nums text-muted">{r.priority}</Td>
      <Td>
        <div className="font-medium">{r.name || <span className="text-muted">sem nome</span>}</div>
        {!r.is_active ? <Badge tone="neutral">inativa</Badge> : null}
      </Td>
      <Td>
        <span className="text-xs text-muted">{MATCH_TYPE_LABELS[r.match_type]}</span>
        {r.path_pattern ? <div className="font-mono text-xs">{r.path_pattern}</div> : null}
      </Td>
      <Td className="max-w-xs text-xs text-muted">{summarizeConditions(r.conditions)}</Td>
      <Td className="text-xs">
        {r.action === "SERVE" ? (
          <span>
            Servir{" "}
            {r.page ? (
              <Link href={`/paginas/${r.page.id}`} className="font-medium hover:text-accent">
                {r.page.name}
              </Link>
            ) : (
              "?"
            )}
            {r.page ? <span className="text-muted"> · {PAGE_KIND_LABELS[r.page.kind]}</span> : null}
            {r.page && r.page.status !== "PUBLISHED" ? <Badge tone="warning" className="ml-1">não publicada</Badge> : null}
            <div className="font-mono text-muted">{r.slug ?? "path da request"}</div>
          </span>
        ) : r.action === "REDIRECT" ? (
          <span>
            Redirecionar ({r.status_code}) → <span className="break-all font-mono">{r.redirect_url}</span>
            {r.preserve_query ? <span className="text-muted"> · mantém query</span> : null}
          </span>
        ) : (
          <span>Bloquear ({r.status_code})</span>
        )}
      </Td>
      <Td className="text-right">
        <div className="flex flex-wrap justify-end gap-1">
          <RowAction action={moveRoute.bind(null, r.id, domainId, "up")} label="↑" variant="ghost" />
          <RowAction action={moveRoute.bind(null, r.id, domainId, "down")} label="↓" variant="ghost" />
          <Button size="sm" variant="secondary" onClick={onEdit}>
            {editing ? "Fechar" : "Editar"}
          </Button>
          <RowAction action={toggleRoute.bind(null, r.id, domainId, !r.is_active)} label={r.is_active ? "Desativar" : "Ativar"} variant="ghost" />
          <RowAction action={deleteRoute.bind(null, r.id, domainId)} label="Remover" variant="danger" confirm="Remover esta rota?" />
        </div>
      </Td>
    </Tr>
  );
}
