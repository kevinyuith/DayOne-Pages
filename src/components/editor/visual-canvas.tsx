"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, DuplicateIcon, TrashIcon } from "@/components/icons";
import {
  assignUids,
  countHidden,
  describe,
  elementByUid,
  injectCanvasChrome,
  serialize,
  UID_ATTR,
  type SelectionInfo,
  type SelectionStyle,
} from "@/lib/pages/html-editing";

/**
 * A canvas de edição visual. Um iframe MESMA-ORIGEM (sandbox="allow-same-origin",
 * sem allow-scripts): o pai lê e mexe no DOM do usuário, e os scripts da página
 * ficam inertes durante a edição. A seleção (contorno + toolbar) é desenhada
 * AQUI no pai, por cima do iframe, para não sujar o documento do usuário — o
 * que é salvo sai limpo por `serialize`.
 *
 * O iframe só é recarregado quando o HTML muda POR FORA (código, troca de slug):
 * as edições visuais atualizam o `html` do pai por `onChange`, e essa volta é
 * ignorada (comparada com o último serialize) para não perder cursor/seleção.
 */

export type CanvasHandle = {
  setText(text: string): void;
  setHref(href: string): void;
  setHidden(hidden: boolean): void;
  setStyleProp(prop: keyof SelectionStyle, value: string): void;
  duplicate(): void;
  remove(): void;
  move(dir: "up" | "down"): void;
  clearSelection(): void;
};

type Rect = { top: number; left: number; width: number; height: number };

const STYLE_TO_CSS: Record<keyof SelectionStyle, string> = {
  color: "color",
  background: "backgroundColor",
  fontSize: "fontSize",
  textAlign: "textAlign",
  padding: "padding",
};

export const VisualCanvas = forwardRef<
  CanvasHandle,
  {
    html: string;
    baseHref?: string;
    onChange: (html: string) => void;
    onSelect: (info: SelectionInfo | null) => void;
    onHiddenCount?: (n: number) => void;
  }
>(function VisualCanvas({ html, baseHref, onChange, onSelect, onHiddenCount }, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const selectedRef = useRef<HTMLElement | null>(null);
  const selectedUidRef = useRef<string | null>(null);
  // Iniciam no html de entrada: o srcDoc do JSX é estável (não recarrega a cada
  // edição); recargas por mudança externa passam pelo efeito abaixo.
  const lastSerializedRef = useRef<string>(html);
  const [rect, setRect] = useState<Rect | null>(null);

  const doc = () => iframeRef.current?.contentDocument ?? null;

  const refreshRect = useCallback(() => {
    const el = selectedRef.current;
    if (!el || !el.isConnected) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, []);

  const emitSelect = useCallback(() => {
    const el = selectedRef.current;
    onSelect(el && el.isConnected ? describe(el) : null);
    refreshRect();
  }, [onSelect, refreshRect]);

  const commit = useCallback(() => {
    const d = doc();
    if (!d) return;
    const out = serialize(d);
    lastSerializedRef.current = out;
    onChange(out);
    onHiddenCount?.(countHidden(d));
  }, [onChange, onHiddenCount]);

  const select = useCallback(
    (el: HTMLElement | null) => {
      selectedRef.current = el;
      selectedUidRef.current = el?.getAttribute(UID_ATTR) ?? null;
      emitSelect();
    },
    [emitSelect],
  );

  // ── Carregar/rehidratar o documento no iframe ──────────────────────────────
  const hydrate = useCallback(() => {
    const d = doc();
    if (!d || !d.body) return;
    injectCanvasChrome(d, baseHref);
    assignUids(d);
    onHiddenCount?.(countHidden(d));

    const onClick = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[contenteditable="true"]')) return; // deixa posicionar o cursor
      e.preventDefault();
      e.stopPropagation();
      const el = target?.closest<HTMLElement>(`[${UID_ATTR}]`) ?? null;
      select(el);
    };
    const onDblClick = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(`[${UID_ATTR}]`);
      if (!el || el.childElementCount > 0) return;
      e.preventDefault();
      el.setAttribute("contenteditable", "true");
      el.focus();
      const finish = () => {
        el.removeAttribute("contenteditable");
        el.removeEventListener("blur", finish);
        el.removeEventListener("keydown", onKey);
        commit();
        if (selectedRef.current === el) emitSelect();
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          el.blur();
        }
      };
      el.addEventListener("blur", finish);
      el.addEventListener("keydown", onKey);
      select(el);
    };
    const block = (e: Event) => e.preventDefault();

    d.addEventListener("click", onClick, true);
    d.addEventListener("dblclick", onDblClick, true);
    d.addEventListener("submit", block, true);
    d.defaultView?.addEventListener("scroll", refreshRect, true);

    // Reencontra a seleção anterior (após recarga externa).
    if (selectedUidRef.current) select(elementByUid(d, selectedUidRef.current));
    else refreshRect();
  }, [baseHref, commit, emitSelect, onHiddenCount, refreshRect, select]);

  // Escreve o markup no iframe e hidrata na hora. document.open/write/close é
  // síncrono e não depende do evento load (que, com srcDoc, não é confiável).
  const hydrateRef = useRef(hydrate);
  useEffect(() => {
    hydrateRef.current = hydrate;
  });
  const writeDoc = useCallback((markup: string) => {
    const cd = iframeRef.current?.contentDocument;
    if (!cd) return;
    cd.open();
    cd.write(markup);
    cd.close();
    hydrateRef.current();
  }, []);

  // Carrega o documento inicial uma vez.
  useEffect(() => {
    lastSerializedRef.current = html;
    writeDoc(html);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recarrega só quando o html vem de fora (≠ do nosso último serialize).
  useEffect(() => {
    if (html === lastSerializedRef.current) return;
    lastSerializedRef.current = html;
    selectedRef.current = null;
    setRect(null);
    writeDoc(html);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  useEffect(() => {
    const onResize = () => refreshRect();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [refreshRect]);

  // ── Comandos (usados pelo inspetor via handle e pela toolbar) ──────────────
  const withSelected = useCallback(
    (fn: (el: HTMLElement) => void, opts: { reindex?: boolean } = {}) => {
      const el = selectedRef.current;
      const d = doc();
      if (!el || !d) return;
      fn(el);
      if (opts.reindex) assignUids(d);
      commit();
      emitSelect();
    },
    [commit, emitSelect],
  );

  const cmdDuplicate = useCallback(
    () =>
      withSelected(
        (el) => {
          const clone = el.cloneNode(true) as HTMLElement;
          el.after(clone);
          selectedRef.current = clone;
        },
        { reindex: true },
      ),
    [withSelected],
  );

  const cmdRemove = useCallback(() => {
    const el = selectedRef.current;
    const d = doc();
    if (!el || !d) return;
    const next = (el.nextElementSibling ?? el.previousElementSibling) as HTMLElement | null;
    el.remove();
    assignUids(d);
    select(next && next.hasAttribute(UID_ATTR) ? next : null);
    commit();
  }, [commit, select]);

  const cmdMove = useCallback(
    (dir: "up" | "down") =>
      withSelected(
        (el) => {
          if (dir === "up") {
            const prev = el.previousElementSibling;
            if (prev) el.parentNode?.insertBefore(el, prev);
          } else {
            const next = el.nextElementSibling;
            if (next) el.parentNode?.insertBefore(next, el);
          }
        },
        { reindex: true },
      ),
    [withSelected],
  );

  useImperativeHandle(
    ref,
    (): CanvasHandle => ({
      setText: (text) => withSelected((el) => (el.textContent = text)),
      setHref: (href) =>
        withSelected((el) => {
          const a = el.tagName === "A" ? el : el.closest("a");
          if (!a) return;
          if (href) a.setAttribute("href", href);
          else a.removeAttribute("href");
        }),
      setHidden: (hidden) =>
        withSelected((el) => {
          el.removeAttribute("hidden");
          el.style.display = hidden ? "none" : "";
          if (!el.style.cssText) el.removeAttribute("style");
        }),
      setStyleProp: (prop, value) =>
        withSelected((el) => {
          el.style.setProperty(STYLE_TO_CSS[prop].replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), value);
          if (!el.style.cssText) el.removeAttribute("style");
        }),
      duplicate: cmdDuplicate,
      remove: cmdRemove,
      move: cmdMove,
      clearSelection: () => select(null),
    }),
    [withSelected, cmdDuplicate, cmdRemove, cmdMove, select],
  );

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        title="Editor da página"
        sandbox="allow-same-origin allow-forms"
        className="block h-full w-full border-0 bg-white"
      />
      {/* Camada de seleção do pai — não intercepta cliques, só a toolbar. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {rect ? (
          <>
            <div
              className="absolute rounded-[2px] outline outline-2 outline-accent"
              style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
            />
            <div
              className="pointer-events-auto absolute flex -translate-y-full items-center gap-0.5 rounded-md bg-accent p-0.5 text-accent-foreground shadow-lg"
              style={{ top: Math.max(rect.top - 6, 22), left: rect.left }}
            >
              <ToolbarButton title="Move up" onClick={() => cmdMove("up")}>
                <ArrowUpIcon className="size-4" />
              </ToolbarButton>
              <ToolbarButton title="Move down" onClick={() => cmdMove("down")}>
                <ArrowDownIcon className="size-4" />
              </ToolbarButton>
              <ToolbarButton title="Duplicate" onClick={cmdDuplicate}>
                <DuplicateIcon className="size-4" />
              </ToolbarButton>
              <ToolbarButton title="Delete" onClick={cmdRemove}>
                <TrashIcon className="size-4" />
              </ToolbarButton>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
});

function ToolbarButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded transition-colors hover:bg-white/20"
    >
      {children}
    </button>
  );
}
