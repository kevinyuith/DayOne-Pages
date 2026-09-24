"use client";

import { Button } from "@/components/ui/button";
import { CHECKBOX_CLASS, SELECT_BASE } from "@/components/ui/field";
import { FUNNEL_MODES, FUNNEL_MODE_LABELS, funnelSlots, type BackTrigger, type FunnelMode, type SubPage, type SubPageKind } from "@/lib/pages/subpages";

/**
 * Painel "Funil": as três etapas fixas desta slug — Pre Lander → Lander →
 * Backredirect —, todas na MESMA URL. Etapa sem código fica inativa (o
 * visitante nunca a vê). O visitante começa no Pre Lander se ele estiver
 * ativo, senão no Lander. Clicar numa etapa ativa troca o que a canvas mostra;
 * Ativar/Desativar mudam o HTML (o pai aplica via `applyDocChange`). O seletor
 * de modo decide quem troca de etapa no visitante: o navegador (tudo no HTML)
 * ou o servidor (uma etapa por resposta, pelo cookie `dop_step`).
 */
export type SubPagesActions = {
  select: (id: string) => void;
  activate: (kind: SubPageKind) => void;
  deactivate: (kind: SubPageKind) => void;
  setTriggers: (id: string, triggers: BackTrigger[]) => void;
  setMode: (mode: FunnelMode) => void;
};

const KIND_TONE: Record<SubPageKind, string> = {
  presell: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  main: "bg-accent/15 text-accent",
  backredirect: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

const KIND_HINT: Record<SubPageKind, string> = {
  presell: "Aquece o visitante e manda para o Lander. Se ativo, é o primeiro que aparece.",
  main: "A oferta. Sem Pre Lander ativo, é o primeiro que aparece.",
  backredirect: "Aparece quando o visitante aperta voltar (ou tenta sair).",
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
  const slots = funnelSlots(pages);
  const activeCount = slots.filter((s) => s.active).length;
  const activeFlow = slots.filter((s) => s.active && s.kind !== "backredirect").length;

  const onDeactivate = (kind: SubPageKind, label: string) => {
    if (!window.confirm(`Desativar o ${label}? O código dele será apagado.`)) return;
    actions.deactivate(kind);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Funil</div>
        <p className="mt-0.5 text-[11px] text-muted">Pre Lander → Lander → Backredirect, na mesma URL. Etapa sem código fica inativa.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <ul className="mb-2 flex flex-col gap-1">
          {slots.map((s, i) => {
            const page = s.page;
            const selected = page != null && page.id === currentId;
            const selectable = s.active && page != null;
            // A última etapa que o visitante pode ver não sai: a página ficaria em branco.
            const onlyVisible = s.kind !== "backredirect" && s.active && activeFlow <= 1;
            return (
              <li key={s.kind} className={`rounded-lg border px-2 py-1.5 text-xs ${selected ? "border-accent/50 bg-accent/10" : "border-border"}`}>
                <button
                  type="button"
                  onClick={() => page && actions.select(page.id)}
                  disabled={!selectable}
                  aria-current={selected ? "true" : undefined}
                  className="flex w-full items-center gap-2 text-left disabled:cursor-default"
                >
                  <span className="w-4 shrink-0 text-center font-mono text-[10px] text-muted">{s.kind === "backredirect" ? "↩" : i + 1}</span>
                  <span className={`min-w-0 flex-1 truncate font-medium ${s.active ? "" : "text-muted"}`}>{s.label}</span>
                  {s.active && s.isStart ? <span className="shrink-0 rounded bg-foreground/10 px-1 text-[9px] font-semibold uppercase">Inicial</span> : null}
                  <span className={`shrink-0 rounded px-1 text-[9px] font-semibold ${s.active ? KIND_TONE[s.kind] : "bg-foreground/10 text-muted"}`}>{s.active ? "Ativa" : "Inativa"}</span>
                </button>
                <p className="mt-1 pl-6 text-[11px] leading-snug text-muted">{KIND_HINT[s.kind]}</p>

                {s.kind === "backredirect" && s.active && page && canEdit ? (
                  <fieldset className="mt-1.5 flex flex-col gap-1 pl-6">
                    <legend className="mb-1 text-[11px] text-muted">Aparece quando o visitante…</legend>
                    <Check checked={page.triggers.includes("back")} onChange={(v) => actions.setTriggers(page.id, toggle(page.triggers, "back", v))}>
                      aperta o botão voltar
                    </Check>
                    <Check checked={page.triggers.includes("exit")} onChange={(v) => actions.setTriggers(page.id, toggle(page.triggers, "exit", v))}>
                      leva o mouse para fechar a aba (exit intent)
                    </Check>
                  </fieldset>
                ) : null}

                {canEdit ? (
                  <div className="mt-1.5 pl-6">
                    {!s.active ? (
                      <Button size="sm" variant="secondary" onClick={() => actions.activate(s.kind)}>
                        Ativar
                      </Button>
                    ) : page ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onDeactivate(s.kind, s.label)}
                        disabled={onlyVisible}
                        title={onlyVisible ? "É a única etapa que o visitante vê" : "Apaga o código desta etapa"}
                      >
                        Desativar
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!canEdit ? <p className="mt-1 text-[11px] text-muted">Volte ao modo Visual (documento completo) para editar o funil.</p> : null}

        {activeCount > 1 ? (
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
                  O servidor entrega <b>só a etapa atual</b>; o fonte do pre lander não contém o lander. Avançar grava o cookie <code>dop_step</code> e recarrega a mesma URL. Cache de HTML
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
            O visitante vê primeiro o <b>Pre Lander</b>, se estiver ativo; senão, o <b>Lander</b>. Para ir do Pre Lander ao Lander, selecione um botão e escolha o destino{" "}
            <b>Próxima etapa</b> (<code>#next-step</code>). O <b>Backredirect</b> aparece quando ele aperta voltar. Desativar apaga o código da etapa. O <code>&lt;head&gt;</code> (CSS) é
            compartilhado entre elas.
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

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" className={CHECKBOX_CLASS} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
