"use client";

import type { ReactNode } from "react";
import { ButtonIcon, CodeIcon, ContainerIcon, ImageIcon, TextIcon, VideoIcon } from "@/components/icons";
import { WIDGETS, widgetHtml, type WidgetKey } from "@/lib/pages/widgets";

/**
 * Painel "Widgets": os blocos básicos, como no builder de referência. Clicar
 * insere o bloco DEPOIS do elemento selecionado na canvas (ou no fim do body)
 * e já o seleciona. Arrastar-e-soltar fica para depois — o clique cobre o uso.
 */
const ICONS: Record<WidgetKey, ReactNode> = {
  text: <TextIcon className="size-5" />,
  image: <ImageIcon className="size-5" />,
  video: <VideoIcon className="size-5" />,
  button: <ButtonIcon className="size-5" />,
  container: <ContainerIcon className="size-5" />,
  html: <CodeIcon className="size-5" />,
};

export function WidgetsPanel({ canInsert, onInsert }: { canInsert: boolean; onInsert: (html: string) => void }) {
  const pick = (key: WidgetKey) => {
    const def = WIDGETS.find((w) => w.key === key)!;
    let value = "";
    if (def.prompt) {
      const v = window.prompt(`${def.prompt.label}:`, "");
      if (v === null) return;
      value = v;
      if (key === "html" && !value.trim()) return;
    }
    onInsert(widgetHtml(key, value));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Widgets</div>
        <p className="mt-0.5 text-[11px] text-muted">
          {canInsert ? "Click to insert after the selected element." : "Switch back to Visual mode (full document) to insert."}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] font-medium text-muted">
          <span>Basic</span>
          <span className="rounded-full bg-foreground/5 px-1.5">{WIDGETS.length}</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {WIDGETS.map((w) => (
            <button
              key={w.key}
              type="button"
              disabled={!canInsert}
              onClick={() => pick(w.key)}
              title={w.hint}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-border px-2 py-3 text-xs text-foreground transition-colors hover:border-accent/50 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="text-muted">{ICONS[w.key]}</span>
              {w.label}
            </button>
          ))}
        </div>
        <p className="mt-3 px-1 text-[11px] text-muted">Sections (Header, Comments, Guarantee…) are coming in a later update.</p>
      </div>
    </div>
  );
}
