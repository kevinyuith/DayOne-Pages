"use client";

import { useState, type ReactNode } from "react";
import { EyeIcon } from "@/components/icons";
import { INPUT_BASE, SELECT_BASE } from "@/components/ui/field";
import type { SelectionInfo, SelectionStyle } from "@/lib/pages/html-editing";

export type InspectorTab = "style" | "settings";

export type InspectorCallbacks = {
  setText: (v: string) => void;
  setHref: (v: string) => void;
  setHidden: (v: boolean) => void;
  setStyle: (prop: keyof SelectionStyle, v: string) => void;
};

/**
 * Painel direito do editor. Duas abas, como no layout de referência: Settings
 * (conteúdo/link/visibilidade do elemento, ou os ajustes da página quando nada
 * está selecionado) e Style (cor, fundo, tamanho, alinhamento, espaçamento).
 */
export function Inspector({
  tab,
  onTab,
  selection,
  callbacks,
  pageSettings,
}: {
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  selection: SelectionInfo | null;
  callbacks: InspectorCallbacks;
  pageSettings: ReactNode;
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
            <ElementSettings key={selection.uid} selection={selection} callbacks={callbacks} />
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

function ElementSettings({ selection, callbacks }: { selection: SelectionInfo; callbacks: InspectorCallbacks }) {
  const [text, setText] = useState(selection.text);
  const [href, setHref] = useState(selection.href);

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

      {selection.isLink ? (
        <Group label="Link (href)">
          <input
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onBlur={() => href !== selection.href && callbacks.setHref(href)}
            placeholder="https://…"
            className={`${INPUT_BASE} w-full`}
          />
        </Group>
      ) : null}

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
