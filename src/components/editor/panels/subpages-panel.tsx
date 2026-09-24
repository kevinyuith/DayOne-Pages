"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CHECKBOX_CLASS, SELECT_BASE, SELECT_CLASS, TEXTAREA_CLASS } from "@/components/ui/field";
import { FUNNEL_MODES, FUNNEL_MODE_LABELS, funnelSlots, trafficShares, type BackTrigger, type FunnelMode, type SubPage, type SubPageKind } from "@/lib/pages/subpages";

/**
 * Painel "Funil": as três etapas fixas desta slug — Pre Lander → Lander →
 * Backredirect —, todas na MESMA URL, e as AMOSTRAS de cada uma (teste A/B).
 * Etapa sem código fica inativa. O visitante começa no Pre Lander se ele
 * estiver ativo, senão no Lander; com várias amostras, o servidor sorteia uma
 * por visitante na proporção dos pesos (fixa para ele). Clicar numa amostra
 * troca o que a canvas mostra; as ações mudam o HTML (o pai aplica via
 * `applyDocChange`). O seletor de modo decide quem troca de etapa: o
 * navegador (tudo no HTML) ou o servidor (uma etapa por resposta).
 */
export type SubPagesActions = {
  select: (id: string) => void;
  activate: (kind: SubPageKind) => void;
  deactivate: (kind: SubPageKind) => void;
  /** Nova amostra: cópia de `from`, o HTML dado ou o modelo inicial. */
  addVersion: (kind: SubPageKind, opts: { from?: string; html?: string }) => void;
  removeVersion: (id: string) => void;
  /** Troca o conteúdo da amostra pelo HTML de uma página inteira. */
  replaceVersion: (id: string, html: string) => void;
  setWeight: (id: string, weight: number) => void;
  splitEvenly: (kind: SubPageKind) => void;
  setTriggers: (ids: string[], triggers: BackTrigger[]) => void;
  setMode: (mode: FunnelMode) => void;
  /** O HTML da slug `/` de um template (para virar amostra). */
  loadTemplate: (templateId: string) => Promise<{ ok: true; html: string } | { ok: false; reason: string }>;
};

/** Visitantes únicos que viram / clicaram cada amostra (página de domínio). */
export type StepStats = Record<string, { views: number; clicks: number }>;

const KIND_TONE: Record<SubPageKind, string> = {
  presell: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  main: "bg-accent/15 text-accent",
  backredirect: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

const KIND_HINT: Record<SubPageKind, string> = {
  presell: "Warms up the visitor and sends them to the Lander. If active, it's the first one shown.",
  main: "The offer. With no active Pre Lander, it's the first one shown.",
  backredirect: "Shows when the visitor presses back (or tries to leave).",
};

/** De onde vem o HTML de uma amostra nova (ou do conteúdo novo de uma). */
type Importing = { kind: SubPageKind; replace: string | null; source: "html" | "template" } | null;

const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

export function SubPagesPanel({
  pages,
  currentId,
  mode,
  canEdit,
  actions,
  stats,
  templates,
}: {
  pages: SubPage[];
  currentId: string | null;
  mode: FunnelMode;
  canEdit: boolean;
  actions: SubPagesActions;
  /** Página de domínio: os resultados de cada amostra (30 dias). Template: null. */
  stats: StepStats | null;
  templates: { id: string; name: string }[];
}) {
  const [importing, setImporting] = useState<Importing>(null);
  const slots = funnelSlots(pages);
  const activeCount = slots.filter((s) => s.active).length;
  const activeFlow = slots.filter((s) => s.active && s.kind !== "backredirect").length;

  const onDeactivate = (kind: SubPageKind, label: string) => {
    if (!window.confirm(`Deactivate the ${label}? The code of all its samples will be deleted.`)) return;
    actions.deactivate(kind);
  };
  const onRemoveVersion = (v: SubPage) => {
    if (!window.confirm(`Remove the sample "${v.name}"? Its code will be deleted.`)) return;
    actions.removeVersion(v.id);
  };
  /** HTML importado: numa etapa inativa com seção vazia, preenche ela; senão, amostra nova (ou troca a escolhida). */
  const applyImport = (html: string) => {
    if (!importing) return;
    const slot = slots.find((s) => s.kind === importing.kind);
    const empty = slot && !slot.active ? slot.versions.find((v) => !v.active) : undefined;
    const target = importing.replace ?? empty?.id ?? null;
    if (target) actions.replaceVersion(target, html);
    else actions.addVersion(importing.kind, { html });
    setImporting(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Funnel</div>
        <p className="mt-0.5 text-[11px] text-muted">Pre Lander → Lander → Backredirect, on the same URL. Each step can have samples (A/B test).</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <ul className="mb-2 flex flex-col gap-1.5">
          {slots.map((s, i) => {
            const selectedHere = s.versions.some((v) => v.id === currentId);
            // A última etapa que o visitante pode ver não sai: a página ficaria em branco.
            const onlyVisible = s.kind !== "backredirect" && s.active && activeFlow <= 1;
            const shares = trafficShares(s.versions);
            const test = s.versions.filter((v) => v.active).length > 1;
            const base = s.versions.find((v) => v.id === currentId) ?? s.versions.find((v) => v.active) ?? s.versions[0];
            const br = s.kind === "backredirect" ? s.versions.find((v) => v.active) : undefined;
            return (
              <li key={s.kind} className={`rounded-lg border px-2 py-1.5 text-xs ${selectedHere ? "border-accent/50" : "border-border"}`}>
                <div className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-center font-mono text-[10px] text-muted">{s.kind === "backredirect" ? "↩" : i + 1}</span>
                  <span className={`min-w-0 flex-1 truncate font-medium ${s.active ? "" : "text-muted"}`}>{s.label}</span>
                  {s.active && s.isStart ? <span className="shrink-0 rounded bg-foreground/10 px-1 text-[9px] font-semibold uppercase">Start</span> : null}
                  <span className={`shrink-0 rounded px-1 text-[9px] font-semibold ${s.active ? KIND_TONE[s.kind] : "bg-foreground/10 text-muted"}`}>{s.active ? "Active" : "Inactive"}</span>
                </div>
                <p className="mt-1 pl-6 text-[11px] leading-snug text-muted">{KIND_HINT[s.kind]}</p>

                {s.versions.length ? (
                  <ul className="mt-1.5 flex flex-col gap-1 pl-6">
                    {s.versions.map((v) => {
                      const st = stats?.[v.id];
                      return (
                        <li key={v.id} className={`rounded-md border px-1.5 py-1 ${v.id === currentId ? "border-accent/50 bg-accent/10" : "border-border"}`}>
                          <div className="flex items-center gap-1.5">
                            <button type="button" onClick={() => actions.select(v.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title="Show on the canvas">
                              <span className="flex size-5 shrink-0 items-center justify-center rounded bg-foreground/10 font-mono text-[10px] font-semibold">{v.version}</span>
                              <span className={`truncate ${v.active ? "" : "text-muted"}`} title={v.active && test ? "Share of the step's traffic" : undefined}>
                                {v.active ? (test ? pct(shares.get(v.id) ?? 0) : "Only sample") : "no code"}
                              </span>
                            </button>
                            {canEdit && s.versions.length > 1 ? (
                              <label className="flex items-center gap-0.5 text-[10px] text-muted" title="Weight in the draw (0 = paused)">
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  value={v.weight}
                                  onChange={(e) => actions.setWeight(v.id, Number(e.target.value))}
                                  aria-label={`Weight of sample ${v.version}`}
                                  className="h-6 w-11 rounded border border-border bg-transparent px-1 text-right text-[11px] text-foreground"
                                />
                              </label>
                            ) : null}
                            {canEdit ? (
                              <Menu label={`Sample ${v.version} options`}>
                                <MenuItem onClick={() => actions.addVersion(s.kind, { from: v.id })}>Duplicate</MenuItem>
                                <MenuItem onClick={() => setImporting({ kind: s.kind, replace: v.id, source: "html" })}>Replace with HTML…</MenuItem>
                                <MenuItem onClick={() => setImporting({ kind: s.kind, replace: v.id, source: "template" })}>Replace with a template…</MenuItem>
                                {s.versions.length > 1 ? (
                                  <MenuItem danger onClick={() => onRemoveVersion(v)}>
                                    Remove sample
                                  </MenuItem>
                                ) : null}
                              </Menu>
                            ) : null}
                          </div>
                          {stats && v.active ? (
                            <p className="mt-0.5 pl-6 text-[10px] tabular-nums text-muted">
                              {st ? `${st.views.toLocaleString("en-US")} views · ${st.clicks.toLocaleString("en-US")} clicks · ${st.views ? pct((st.clicks / st.views) * 100) : "—"}` : "no views in 30 days"}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}

                {br && canEdit ? (
                  <fieldset className="mt-1.5 flex flex-col gap-1 pl-6">
                    <legend className="mb-1 text-[11px] text-muted">Shows when the visitor…</legend>
                    <Check
                      checked={br.triggers.includes("back")}
                      onChange={(on) => actions.setTriggers(s.versions.map((v) => v.id), toggle(br.triggers, "back", on))}
                    >
                      presses the back button
                    </Check>
                    <Check
                      checked={br.triggers.includes("exit")}
                      onChange={(on) => actions.setTriggers(s.versions.map((v) => v.id), toggle(br.triggers, "exit", on))}
                    >
                      moves the mouse to close the tab (exit intent)
                    </Check>
                  </fieldset>
                ) : null}

                {canEdit ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-6">
                    {!s.active ? (
                      <Button size="sm" variant="secondary" onClick={() => actions.activate(s.kind)}>
                        Activate
                      </Button>
                    ) : null}
                    <Menu label="New sample" trigger={s.active ? "+ Sample" : "Activate with…"}>
                      {s.active && base ? <MenuItem onClick={() => actions.addVersion(s.kind, { from: base.id })}>Copy of sample {base.version}</MenuItem> : null}
                      {s.active ? <MenuItem onClick={() => actions.addVersion(s.kind, {})}>Blank starter</MenuItem> : null}
                      <MenuItem onClick={() => setImporting({ kind: s.kind, replace: null, source: "html" })}>Paste HTML…</MenuItem>
                      <MenuItem onClick={() => setImporting({ kind: s.kind, replace: null, source: "template" })}>From a template…</MenuItem>
                    </Menu>
                    {test ? (
                      <button type="button" onClick={() => actions.splitEvenly(s.kind)} className="text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline">
                        Split evenly
                      </button>
                    ) : null}
                    {s.active && !s.plain ? (
                      <button
                        type="button"
                        onClick={() => onDeactivate(s.kind, s.label)}
                        disabled={onlyVisible}
                        title={onlyVisible ? "It's the only step the visitor sees" : "Deletes this step's code (all samples)"}
                        className="ml-auto text-[11px] text-muted hover:text-red-600 disabled:opacity-40 disabled:hover:text-muted"
                      >
                        Deactivate
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!canEdit ? <p className="mt-1 text-[11px] text-muted">Switch back to Visual mode (full document) to edit the funnel.</p> : null}

        {activeCount > 1 ? (
          <div className="mt-3 flex flex-col gap-1 rounded-lg border border-border p-2">
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Step switching
              <select value={mode} onChange={(e) => actions.setMode(e.target.value as FunnelMode)} aria-label="Funnel mode" className={`${SELECT_BASE} h-8 w-full text-xs text-foreground`} disabled={!canEdit}>
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
                  The server delivers <b>only the current step</b>; the pre lander&apos;s source doesn&apos;t contain the lander. Moving forward sets the <code>dop_step</code> cookie and reloads the same URL. HTML caching
                  on Cloudflare must stay off (the server already sends <code>Vary: Cookie</code>).
                </>
              ) : (
                <>
                  All steps go in the HTML and the script switches instantly, without reloading. Faster, but anyone who opens the source sees the other steps (never the other samples: the
                  server only sends the drawn one).
                </>
              )}
            </p>
          </div>
        ) : null}

        <div className="mt-3 rounded-lg bg-foreground/5 p-2 text-[11px] leading-snug text-muted">
          <p className="mb-1 font-medium text-foreground">How it works</p>
          <p>
            The visitor sees the <b>Pre Lander</b> first, if it&apos;s active; otherwise, the <b>Lander</b>. To go from the Pre Lander to the Lander, select a button and choose the destination{" "}
            <b>Next step</b> (<code>#next-step</code>). The <b>Backredirect</b> shows when they press back.
          </p>
          <p className="mt-1">
            <b>A/B test:</b> with two or more samples in a step, the server draws one per visitor in proportion to the weights, and the visitor always stays on it. Weight 0 pauses a
            sample. Views and clicks (to the next step or out of the page) show on the domain page and on the Funnel screen. A pasted page&apos;s CSS goes with its sample.
          </p>
        </div>
      </div>

      <ImportDialog importing={importing} templates={templates} onClose={() => setImporting(null)} onApply={applyImport} loadTemplate={actions.loadTemplate} />
    </div>
  );
}

/** Colar o HTML de uma página ou escolher um template, para virar amostra (ou o conteúdo de uma). */
function ImportDialog({
  importing,
  templates,
  onClose,
  onApply,
  loadTemplate,
}: {
  importing: Importing;
  templates: { id: string; name: string }[];
  onClose: () => void;
  onApply: (html: string) => void;
  loadTemplate: SubPagesActions["loadTemplate"];
}) {
  const [html, setHtml] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setHtml("");
    setError(null);
    onClose();
  };
  const submit = async () => {
    setError(null);
    if (importing?.source === "template") {
      if (!templateId) return setError("Choose a template.");
      setBusy(true);
      const r = await loadTemplate(templateId);
      setBusy(false);
      if (!r.ok) return setError(r.reason);
      onApply(r.html);
    } else {
      if (!html.trim()) return setError("Paste the page's HTML.");
      onApply(html);
    }
    setHtml("");
  };
  const title = importing?.replace ? "Replace the sample's content" : "New sample";
  return (
    <Dialog
      open={importing !== null}
      title={title}
      description={
        importing?.source === "template"
          ? "The template's / slug becomes the sample's content (with its CSS)."
          : "Paste the whole page: the <body> becomes the sample, and the <head>'s CSS/scripts go with it."
      }
      onClose={close}
      className="sm:max-w-2xl"
    >
      <div className="flex flex-col gap-3">
        {importing?.source === "template" ? (
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template" className={SELECT_CLASS} disabled={busy}>
            <option value="">— choose —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : (
          <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={12} placeholder="<!doctype html>…" className={`${TEXTAREA_CLASS} font-mono text-xs`} />
        )}
        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="flex gap-2">
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Loading…" : importing?.replace ? "Replace" : "Create sample"}
          </Button>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Menu({ label, trigger = "⋯", children }: { label: string; trigger?: string; children: React.ReactNode }) {
  return (
    <details className="relative">
      <summary aria-label={label} title={label} className="flex h-6 cursor-pointer list-none items-center rounded px-1.5 text-[11px] text-muted hover:bg-foreground/5 hover:text-foreground">
        {trigger}
      </summary>
      <div
        className="absolute right-0 z-30 mt-1 flex w-48 flex-col rounded-lg border border-border bg-surface p-1 shadow-lg"
        // Fecha o <details> depois de escolher.
        onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement | null)?.removeAttribute("open")}
      >
        {children}
      </div>
    </details>
  );
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-left text-xs hover:bg-foreground/5 ${danger ? "text-red-600 dark:text-red-400" : ""}`}
    >
      {children}
    </button>
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
