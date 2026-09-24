"use client";

import { useState, type ReactNode } from "react";
import { EyeIcon, LinkIcon, UnlinkIcon } from "@/components/icons";
import { CHECKBOX_CLASS, INPUT_BASE, SELECT_BASE } from "@/components/ui/field";
import type { LinkSource, SelectionInfo, SelectionStyle } from "@/lib/pages/html-editing";

export type InspectorTab = "style" | "settings";

export type InspectorCallbacks = {
  setText: (v: string) => void;
  /** Link do elemento: nativo (<a>) ou atrelado (data-href). `href` vazio remove. */
  setLink: (href: string, target: string) => void;
  clearLink: () => void;
  setHidden: (v: boolean) => void;
  setStyle: (prop: keyof SelectionStyle, v: string) => void;
};

/**
 * Painel direito do editor. Duas abas, como no layout de referência: Settings
 * (conteúdo/link/visibilidade do elemento, ou os ajustes da página quando nada
 * está selecionado) e Style (cor, fundo, tamanho, alinhamento, espaçamento).
 */
/** Um destino pronto para o seletor de link (etapa do funil, outra slug…). */
export type LinkDestination = { label: string; href: string; group: string };

export function Inspector({
  tab,
  onTab,
  selection,
  callbacks,
  pageSettings,
  destinations = [],
}: {
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  selection: SelectionInfo | null;
  callbacks: InspectorCallbacks;
  pageSettings: ReactNode;
  destinations?: LinkDestination[];
}) {
  return (
    <aside className="flex min-h-0 w-72 shrink-0 flex-col rounded-xl border border-border bg-surface">
      <div className="flex shrink-0 border-b border-border p-1">
        {(["style", "settings"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t ? "bg-accent/10 text-accent" : "text-muted hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "settings" ? (
          selection ? (
            <ElementSettings key={selection.uid} selection={selection} callbacks={callbacks} destinations={destinations} />
          ) : (
            pageSettings
          )
        ) : selection ? (
          <ElementStyle key={selection.uid} selection={selection} setStyle={callbacks.setStyle} />
        ) : (
          <Empty>Select an element on the canvas to style it.</Empty>
        )}
      </div>
    </aside>
  );
}

function ElementSettings({ selection, callbacks, destinations }: { selection: SelectionInfo; callbacks: InspectorCallbacks; destinations: LinkDestination[] }) {
  const [text, setText] = useState(selection.text);

  return (
    <div className="flex flex-col gap-4">
      <SelectedTag selection={selection} />

      {selection.textEditable ? (
        <Group label="Text">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== selection.text && callbacks.setText(text)}
            rows={3}
            className={`${INPUT_BASE} w-full py-2`}
          />
        </Group>
      ) : null}

      {/* Remonta quando o link muda por fora (Remover, troca em massa no painel Links). */}
      <LinkSettings key={`${selection.href}|${selection.linkTarget}`} selection={selection} callbacks={callbacks} destinations={destinations} />

      <Group label="Visibility">
        <button
          type="button"
          onClick={() => callbacks.setHidden(!selection.hidden)}
          className={`flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:border-foreground/20`}
        >
          <span className={selection.hidden ? "text-muted" : ""}>{selection.hidden ? "Hidden" : "Visible"}</span>
          <EyeIcon className={`size-4 ${selection.hidden ? "text-muted/50" : "text-accent"}`} />
        </button>
      </Group>
    </div>
  );
}

const LINK_HINT: Record<LinkSource, (tag: string) => string> = {
  anchor: (tag) => (tag === "form" ? "Destino do formulário (action)." : "Link nativo deste elemento (href)."),
  inherited: () => "Herdado do <a> que envolve este elemento — editar mexe nele.",
  attached: (tag) => `Atrelado a este <${tag}> (data-href). O clique navega; a slug da página não muda.`,
  none: (tag) => `Sem link. Cole um destino para atrelar um link a este <${tag}> — sem mexer na estrutura nem na slug.`,
};

/**
 * Link do elemento: um campo só, que edita o href de um <a> (ou do <a> pai) e,
 * para qualquer outro elemento, atrela um link via data-href. É o "atrelar
 * links a novos elementos sem mudar a slug".
 */
function LinkSettings({ selection, callbacks, destinations }: { selection: SelectionInfo; callbacks: InspectorCallbacks; destinations: LinkDestination[] }) {
  const [href, setHref] = useState(selection.href);
  const newTab = selection.linkTarget === "_blank";
  const commit = () => {
    const v = href.trim();
    if (v !== selection.href) callbacks.setLink(v, selection.linkTarget);
  };

  // "Destino", como o Navigation → Destination da referência: uma slug desta
  // página, uma âncora (#id) ou uma URL livre. O valor é derivado do href.
  const kind = destinations.some((d) => d.href === href.trim()) ? href.trim() : href.trim().startsWith("#") ? "#" : "";
  const onKind = (v: string) => {
    if (v === "#") {
      setHref("#");
      return;
    }
    if (v === "") {
      setHref("");
      return;
    }
    setHref(v);
    if (v !== selection.href) callbacks.setLink(v, selection.linkTarget);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <LinkIcon className="size-3.5" /> Link
        </span>
        {selection.isLink ? (
          <button
            type="button"
            onClick={callbacks.clearLink}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-red-600 dark:hover:text-red-400"
            title="Remover link"
          >
            <UnlinkIcon className="size-3.5" /> Remover
          </button>
        ) : null}
      </div>
      {destinations.length ? (
        <select value={kind} onChange={(e) => onKind(e.target.value)} aria-label="Destino" className={`${SELECT_BASE} h-8 w-full text-xs`}>
          <option value="">URL externa / personalizada</option>
          <option value="#">Âncora nesta página (#id)</option>
          {Array.from(new Set(destinations.map((d) => d.group))).map((g) => (
            <optgroup key={g} label={g}>
              {destinations
                .filter((d) => d.group === g)
                .map((d) => (
                  <option key={d.href} value={d.href}>
                    {d.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      ) : null}
      <input
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        placeholder="https://… ou #secao"
        className={`${INPUT_BASE} w-full font-mono text-xs`}
      />
      <label className={`flex items-center gap-2 text-xs ${selection.isLink ? "" : "opacity-50"}`}>
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          checked={newTab}
          disabled={!selection.isLink}
          onChange={(e) => callbacks.setLink(selection.href, e.target.checked ? "_blank" : "")}
        />
        Abrir em nova aba
      </label>
      <p className="text-[11px] leading-snug text-muted">
        {selection.href === "#next-step" || selection.href.startsWith("#page:")
          ? "Troca a etapa do funil (Pre Lander → Lander) — a URL não muda."
          : LINK_HINT[selection.linkSource](selection.tag)}
      </p>
    </div>
  );
}

function ElementStyle({ selection, setStyle }: { selection: SelectionInfo; setStyle: (p: keyof SelectionStyle, v: string) => void }) {
  const s = selection.style;
  return (
    <div className="flex flex-col gap-4">
      <SelectedTag selection={selection} />
      <ColorRow label="Text color" value={s.color} onChange={(v) => setStyle("color", v)} />
      <ColorRow label="Background" value={s.background} onChange={(v) => setStyle("background", v)} />
      <Group label="Font size">
        <TextField value={s.fontSize} placeholder="16px" onCommit={(v) => setStyle("fontSize", v)} />
      </Group>
      <Group label="Align">
        <select value={s.textAlign} onChange={(e) => setStyle("textAlign", e.target.value)} className={`${SELECT_BASE} w-full`}>
          <option value="">default</option>
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
          <option value="justify">justify</option>
        </select>
      </Group>
      <Group label="Padding">
        <TextField value={s.padding} placeholder="16px" onCommit={(v) => setStyle("padding", v)} />
      </Group>
    </div>
  );
}

function SelectedTag({ selection }: { selection: SelectionInfo }) {
  return (
    <div className="flex items-center gap-2">
      <code className="rounded-md bg-foreground/5 px-2 py-0.5 text-xs font-medium text-accent">&lt;{selection.tag}&gt;</code>
      <span className="text-xs text-muted">selected</span>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const safe = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <Group label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={safe}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-background"
        />
        <input value={value} readOnly placeholder="inherit" className={`${INPUT_BASE} w-full font-mono text-xs`} />
        {value ? (
          <button type="button" onClick={() => onChange("")} className="shrink-0 px-1 text-xs text-muted hover:text-foreground" title="Clear">
            ×
          </button>
        ) : null}
      </div>
    </Group>
  );
}

function TextField({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      placeholder={placeholder}
      className={`${INPUT_BASE} w-full`}
    />
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}
