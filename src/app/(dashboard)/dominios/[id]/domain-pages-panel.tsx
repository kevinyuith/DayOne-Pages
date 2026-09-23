"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RowAction } from "@/components/row-action";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { SELECT_CLASS } from "@/components/ui/field";
import type { DomainDetail, DomainPage, TemplateOption } from "@/lib/pages/queries";
import { PAGE_KIND_LABELS, PAGE_STATUS_LABELS } from "@/lib/pages/types";
import { copyTemplateToDomain, removeDomainPage, replaceDomainPage, setDefaultPage } from "../actions";

/**
 * As páginas do domínio: cópias de templates que só este domínio serve
 * (domains.site). Editar uma não muda o template, e mudar o template não
 * muda a cópia. Daqui: copiar um template, abrir no editor, trocar o
 * template (substitui a cópia), escolher a padrão e remover a que não está
 * em uso.
 */
export function DomainPagesPanel({ domain, templates }: { domain: DomainDetail; templates: TemplateOption[] }) {
  const usage = (p: DomainPage): string[] => {
    const uses: string[] = [];
    if (domain.default_page_id === p.id) uses.push("Padrão");
    if (domain.filter && domain.filter_pass_page_id === p.id) uses.push("Filtro: aprovado");
    if (domain.filter && domain.filter_fail_page_id === p.id) uses.push("Filtro: reprovado");
    for (const r of domain.routes) {
      if (r.page_id === p.id) uses.push(`Rota: ${r.name || r.path_pattern || "qualquer path"}`);
    }
    return uses;
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold">Páginas do domínio</h2>
      <p className="mt-1 text-xs text-muted">
        Cópias de templates que só este domínio serve. Editar aqui não muda o template, e mudar o template não muda estas páginas.
      </p>

      {domain.pages.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
          Este domínio ainda não tem página. Copie um template abaixo: a primeira cópia vira a página padrão.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border/60">
          {domain.pages.map((p) => (
            <PageRow key={p.id} domainId={domain.id} page={p} uses={usage(p)} isDefault={domain.default_page_id === p.id} templates={templates} />
          ))}
        </ul>
      )}

      {!domain.default_page_id && domain.pages.length > 0 ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">Sem página padrão: paths sem rota respondem 404.</p>
      ) : null}
      {domain.default_page && domain.default_page.status !== "PUBLISHED" ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">A página padrão não está publicada e não será servida.</p>
      ) : null}
      {domain.filter && domain.filter_fail_page_id ? (
        <p className="mt-3 text-xs text-muted">Há um filtro ativo: quem não passa vê a página de reprovação, não a padrão.</p>
      ) : null}

      <CopyTemplateForm domainId={domain.id} templates={templates} />
    </section>
  );
}

function PageRow({
  domainId,
  page,
  uses,
  isDefault,
  templates,
}: {
  domainId: string;
  page: DomainPage;
  uses: string[];
  isDefault: boolean;
  templates: TemplateOption[];
}) {
  const [replacing, setReplacing] = useState(false);
  const editHref = `/dominios/${domainId}/paginas/${page.id}`;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={editHref} className="font-medium hover:underline">
              {page.name}
            </Link>
            <Badge tone={PAGE_STATUS_TONE[page.status]}>{PAGE_STATUS_LABELS[page.status]}</Badge>
            {uses.map((u) => (
              <Badge key={u} tone="info">
                {u}
              </Badge>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">
            {PAGE_KIND_LABELS[page.kind]} · {page.slugs.length} {page.slugs.length === 1 ? "slug" : "slugs"} · copiada do template{" "}
            {page.template_name ? `"${page.template_name}"` : "(removido)"}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Link href={editHref} className={buttonClass("primary", "sm")}>
            Editar
          </Link>
          {!isDefault ? <RowAction action={setDefaultPage.bind(null, domainId, page.id)} label="Tornar padrão" pendingLabel="Salvando…" /> : null}
          <Button size="sm" variant="ghost" onClick={() => setReplacing((v) => !v)}>
            Trocar template
          </Button>
          {uses.length === 0 ? (
            <RowAction
              action={removeDomainPage.bind(null, domainId, page.id)}
              label="Remover"
              variant="danger"
              confirm={`Remover "${page.name}" deste domínio? O HTML dela será perdido.`}
            />
          ) : null}
        </div>
      </div>
      {replacing ? <ReplaceForm domainId={domainId} page={page} templates={templates} onDone={() => setReplacing(false)} /> : null}
    </li>
  );
}

/** Troca o conteúdo da página por uma cópia nova de outro template (o mesmo também vale: volta ao original). */
function ReplaceForm({ domainId, page, templates, onDone }: { domainId: string; page: DomainPage; templates: TemplateOption[]; onDone: () => void }) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(page.template_id ?? templates[0]?.id ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const t = templates.find((x) => x.id === templateId);
    if (!t) return;
    if (!window.confirm(`Substituir "${page.name}" por uma cópia nova do template "${t.name}"? As edições feitas nesta página serão perdidas.`)) return;
    start(async () => {
      const r = await replaceDomainPage(domainId, page.id, templateId);
      if (!r.ok) return setError(r.reason);
      setError(null);
      onDone();
      router.refresh();
    });
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border bg-foreground/[0.02] p-3 sm:flex-row sm:items-center">
      <span className="text-xs text-muted sm:shrink-0">Novo template:</span>
      <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={pending} className={`${SELECT_CLASS} sm:max-w-xs`}>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} · {PAGE_KIND_LABELS[t.kind]}
          </option>
        ))}
      </select>
      <Button size="sm" variant="danger" onClick={submit} disabled={pending || !templateId}>
        {pending ? "Substituindo…" : "Substituir"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone} disabled={pending}>
        Cancelar
      </Button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}

function CopyTemplateForm({ domainId, templates }: { domainId: string; templates: TemplateOption[] }) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (templates.length === 0) {
    return (
      <p className="mt-4 text-xs text-muted">
        Não há templates. Crie um em{" "}
        <Link href="/paginas" className="underline">
          Templates de página
        </Link>
        .
      </p>
    );
  }

  const submit = () =>
    start(async () => {
      const r = await copyTemplateToDomain(domainId, templateId);
      setMessage(r.ok ? { ok: true, text: "Copiado. Clique em Editar para personalizar a página deste domínio." } : { ok: false, text: r.reason });
      if (r.ok) router.refresh();
    });

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="text-xs font-medium sm:shrink-0">Copiar template para o domínio:</span>
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={pending} className={`${SELECT_CLASS} sm:max-w-xs`}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {PAGE_KIND_LABELS[t.kind]} · {t.slugs_count} {t.slugs_count === 1 ? "slug" : "slugs"}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={submit} disabled={pending || !templateId}>
          {pending ? "Copiando…" : "Copiar"}
        </Button>
      </div>
      {message ? (
        <p role={message.ok ? "status" : "alert"} className={`mt-2 text-xs ${message.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
