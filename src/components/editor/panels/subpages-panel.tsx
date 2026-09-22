"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, DuplicateIcon, PlusIcon, TrashIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CHECKBOX_CLASS, SELECT_BASE } from "@/components/ui/field";
import { FUNNEL_MODES, FUNNEL_MODE_LABELS, PAGE_KINDS_SUB, SUB_KIND_LABELS, type BackTrigger, type FunnelMode, type SubPage, type SubPageKind } from "@/lib/pages/subpages";

/**
 * Painel "Funil": as sub-páginas desta slug (presell → principal → back
 * redirect…), todas na MESMA URL. Clicar numa troca o que a canvas mostra; as
 * ações mudam o HTML (o pai aplica via `applyDocChange`). O seletor de modo
 * decide quem troca de etapa no visitante: o navegador (tudo no HTML) ou o
 * servidor (uma etapa por resposta, pelo cookie `dop_step`).
 */
export type SubPagesActions = {
  select: (id: string) => void;
  add: (kind: SubPageKind, name: string) => void;
  rename: (id: string, name: string) => void;
  setStart: (id: string) => void;
  setKind: (id: string, kind: SubPageKind) => void;
  setTriggers: (id: string, triggers: BackTrigger[]) => void;
  move: (id: string, dir: "up" | "down") => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  setMode: (mode: FunnelMode) => void;
};

const KIND_TONE: Record<SubPageKind, string> = {
  main: "bg-accent/15 text-accent",
  presell: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  upsell: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  downsell: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  backredirect: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

export function SubPagesPanel({
  pages,
  currentId,
  mode,
  canEdit,
  actions,
}: {
  pages: SubPage[];
  currentId: string | null;
  mode: FunnelMode;
  canEdit: boolean;
  actions: SubPagesActions;
}) {
  const [addKind, setAddKind] = useState<SubPageKind>("presell");
  const current = pages.find((p) => p.id === currentId) ?? null;
  const idx = current ? pages.indexOf(current) : -1;

  const onAdd = () => {
    const name = window.prompt("Nome da sub-página:", SUB_KIND_LABELS[addKind]);
    if (name === null) return;
    actions.add(addKind, name.trim() || SUB_KIND_LABELS[addKind]);
  };
  const onRename = () => {
    if (!current) return;
    const name = window.prompt("Novo nome:", current.name);
    if (name === null || !name.trim()) return;
    actions.rename(current.id, name.trim());
  };
  const onRemove = () => {
    if (!current) return;
    if (!window.confirm(`Remover a sub-página "${current.name}"? O HTML dela será perdido.`)) return;
    actions.remove(current.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Funil</div>
        <p className="mt-0.5 text-[11px] text-muted">Sub-páginas desta slug — mesma URL, a troca acontece {mode === "server" ? "no servidor" : "no navegador"}.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {pages.length === 0 ? (
          <p className="px-1 pb-3 text-xs text-muted">Esta slug tem uma página só. Adicione uma sub-página para montar um funil (presell → oferta → back redirect) sem mudar a URL.</p>
        ) : (
          <ul className="mb-2 flex flex-col gap-1">
            {pages.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => actions.select(p.id)}
                  aria-current={p.id === currentId ? "true" : undefined}
                  className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${
                    p.id === currentId ? "border-accent/50 bg-accent/10" : "border-border hover:bg-foreground/5"
                  }`}
                >
                  <span className="w-4 shrink-0 text-center font-mono text-[10px] text-muted">{p.kind === "backredirect" ? "↩" : i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  {p.isStart ? <span className="shrink-0 rounded bg-foreground/10 px-1 text-[9px] font-semibold uppercase">Inicial</span> : null}
                  <span className={`shrink-0 rounded px-1 text-[9px] font-semibold ${KIND_TONE[p.kind]}`}>{SUB_KIND_LABELS[p.kind]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-1">
          <select value={addKind} onChange={(e) => setAddKind(e.target.value as SubPageKind)} aria-label="Tipo da nova sub-página" className={`${SELECT_BASE} h-8 w-full text-xs`} disabled={!canEdit}>
            {PAGE_KINDS_SUB.map((k) => (
              <option key={k} value={k}>
                {SUB_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={onAdd} disabled={!canEdit} title="Adicionar sub-página">
            <PlusIcon className="size-4" />
          </Button>
        </div>
        {!canEdit ? <p className="mt-1 text-[11px] text-muted">Volte ao modo Visual (documento completo) para editar o funil.</p> : null}

        {current && canEdit ? (
          <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border p-2">
            <div className="flex items-center justify-between">
              <span className="truncate text-xs font-medium">{current.name}</span>
              <div className="flex gap-0.5">
                <Icon title="Mover para cima" disabled={idx <= 0} onClick={() => actions.move(current.id, "up")}>
                  <ArrowUpIcon className="size-3.5" />
                </Icon>
                <Icon title="Mover para baixo" disabled={idx < 0 || idx >= pages.length - 1} onClick={() => actions.move(current.id, "down")}>
                  <ArrowDownIcon className="size-3.5" />
                </Icon>
                <Icon title="Duplicar" onClick={() => actions.duplicate(current.id)}>
                  <DuplicateIcon className="size-3.5" />
                </Icon>
                <Icon title="Remover" onClick={onRemove}>
                  <TrashIcon className="size-3.5" />
                </Icon>
              </div>
            </div>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Tipo
              <select value={current.kind} onChange={(e) => actions.setKind(current.id, e.target.value as SubPageKind)} className={`${SELECT_BASE} h-8 w-full text-xs text-foreground`}>
                {PAGE_KINDS_SUB.map((k) => (
                  <option key={k} value={k}>
                    {SUB_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            {current.kind === "backredirect" ? (
              <fieldset className="flex flex-col gap-1 text-xs">
                <legend className="mb-1 text-[11px] text-muted">Aparece quando o visitante…</legend>
                <Check checked={current.triggers.includes("back")} onChange={(v) => actions.setTriggers(current.id, toggle(current.triggers, "back", v))}>
                  aperta o botão voltar
                </Check>
                <Check checked={current.triggers.includes("exit")} onChange={(v) => actions.setTriggers(current.id, toggle(current.triggers, "exit", v))}>
                  leva o mouse para fechar a aba (exit intent)
                </Check>
              </fieldset>
            ) : (
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => actions.setStart(current.id)} disabled={current.isStart}>
                  {current.isStart ? "É a inicial" : "Tornar inicial"}
                </Button>
                <Button size="sm" variant="ghost" onClick={onRename}>
                  Renomear
                </Button>
              </div>
            )}
            {current.kind === "backredirect" ? (
              <Button size="sm" variant="ghost" onClick={onRename} className="self-start">
                Renomear
              </Button>
            ) : null}
          </div>
        ) : null}

        {pages.length > 1 ? (
          <div className="mt-3 flex flex-col gap-1 rounded-lg border border-border p-2">
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Troca de etapa
              <select value={mode} onChange={(e) => actions.setMode(e.target.value as FunnelMode)} aria-label="Modo do funil" className={`${SELECT_BASE} h-8 w-full text-xs text-foreground`} disabled={!canEdit}>
                {FUNNEL_MODES.map((m) => (
                  <option key={m} value={m}>
                    {FUNNEL_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[11px] leading-snug text-muted">
              {mode === "server" ? (
                <>
                  O servidor entrega <b>só a etapa atual</b>; o fonte da presell não contém a principal. Avançar grava o cookie <code>dop_step</code> e recarrega a mesma URL. Cache de HTML
                  no Cloudflare precisa ficar desligado (o servidor já manda <code>Vary: Cookie</code>).
                </>
              ) : (
                <>
                  Todas as etapas vão no HTML e o script troca na hora, sem recarregar. Mais rápido, mas quem abrir o fonte vê as outras etapas.
                </>
              )}
            </p>
          </div>
        ) : null}

        <div className="mt-3 rounded-lg bg-foreground/5 p-2 text-[11px] leading-snug text-muted">
          <p className="mb-1 font-medium text-foreground">Como funciona</p>
          <p>
            A <b>inicial</b> é a primeira que o visitante vê. Para avançar, selecione um botão (ou qualquer elemento) e escolha o destino <b>Próxima sub-página</b> (<code>#next-step</code>) ou
            uma sub-página específica (<code>#page:id</code>). A <b>back redirect</b> aparece quando ele aperta voltar. O <code>&lt;head&gt;</code> (CSS) é compartilhado entre elas.
          </p>
        </div>
      </div>
    </div>
  );
}

function toggle(list: BackTrigger[], t: BackTrigger, on: boolean): BackTrigger[] {
  const set = new Set(list);
  if (on) set.add(t);
  else set.delete(t);
  return (["back", "exit"] as const).filter((x) => set.has(x));
}

function Icon({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className="flex size-6 items-center justify-center rounded text-muted hover:bg-foreground/5 hover:text-foreground disabled:opacity-30">
      {children}
    </button>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" className={CHECKBOX_CLASS} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
