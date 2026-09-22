"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, DuplicateIcon, LinkIcon, TrashIcon } from "@/components/icons";
import {
  assignUids,
  countHidden,
  describe,
  elementByUid,
  HREF_ATTR,
  injectCanvasChrome,
  PAGE_ATTR,
  RUNTIME_ATTR,
  serialize,
  UID_ATTR,
  type SelectionInfo,
  type SelectionStyle,
} from "@/lib/pages/html-editing";
import { clearLink, setLink } from "@/lib/pages/links";
import { syncRuntime } from "@/lib/pages/runtime";
import { normalizePages, pageById, pageOf, setCurrent, startPage } from "@/lib/pages/subpages";

/**
 * Marcadores de link no canvas (como os "markers" do builder de referência):
 * um chip por link visível, desenhado pelo pai por cima do iframe. Clicar no
 * chip seleciona o elemento. Recalculados a cada mudança/rolagem, via rAF.
 */
type Marker = { uid: string; kind: "a" | "form" | "atrelado"; top: number; left: number };
const MARKER_SELECTOR = `a[href], area[href], form[action], [${HREF_ATTR}]`;

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
  /** Define o link do elemento selecionado (nativo ou atrelado). `href` vazio remove. */
  setLink(href: string, target?: string): void;
  clearLink(): void;
  setHidden(hidden: boolean): void;
  setStyleProp(prop: keyof SelectionStyle, value: string): void;
  duplicate(): void;
  remove(): void;
  move(dir: "up" | "down"): void;
  clearSelection(): void;
  /** Seleciona pelo uid (painéis Links/Camadas) e rola até o elemento. */
  selectByUid(uid: string): void;
  /**
   * Roda `fn` no documento AO VIVO (sem recarregar o iframe), reindexa se a
   * estrutura mudou e grava. É a porta dos painéis para trocas em massa.
   */
  mutate(fn: (doc: Document) => void, opts?: { reindex?: boolean }): void;
  /** Insere HTML depois do elemento selecionado (ou no fim do body) e o seleciona. */
  insertHtml(markup: string): void;
};

type Rect = { uid: string; top: number; left: number; width: number; height: number };

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
    /** Mostra um chip sobre cada link (a / form / atrelado). */
    showMarkers?: boolean;
    /** Sub-página que a canvas mostra (null numa slug de página única). */
    currentPageId?: string | null;
    /** A canvas trocou de sub-página por conta própria (seleção em outra página, página removida…). */
    onPageChange?: (id: string | null) => void;
  }
>(function VisualCanvas({ html, baseHref, onChange, onSelect, onHiddenCount, showMarkers = false, currentPageId = null, onPageChange }, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const selectedRef = useRef<HTMLElement | null>(null);
  const selectedUidRef = useRef<string | null>(null);
  // Iniciam no html de entrada: o srcDoc do JSX é estável (não recarrega a cada
  // edição); recargas por mudança externa passam pelo efeito abaixo.
  const lastSerializedRef = useRef<string>(html);
  const [rect, setRect] = useState<Rect | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const showMarkersRef = useRef(showMarkers);
  useEffect(() => {
    showMarkersRef.current = showMarkers;
  }, [showMarkers]);

  const doc = () => iframeRef.current?.contentDocument ?? null;

  // ── Sub-página atual ───────────────────────────────────────────────────────
  // A canvas mostra UMA sub-página por vez (atributo data-dop-current, só do
  // editor). O pai manda a desejada; se ela não existe mais, cai na inicial e
  // avisa. `ensureCurrent` roda após hidratar e após cada mutação estrutural.
  const currentPageIdRef = useRef<string | null>(currentPageId);
  const onPageChangeRef = useRef(onPageChange);
  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  });
  const ensureCurrent = useCallback((d: Document) => {
    const want = currentPageIdRef.current;
    const id = want && pageById(d, want) ? want : (startPage(d)?.getAttribute(PAGE_ATTR) ?? null);
    setCurrent(d, id);
    if (id !== want) {
      currentPageIdRef.current = id;
      onPageChangeRef.current?.(id);
    }
  }, []);

  const markersRaf = useRef(0);
  const refreshMarkers = useCallback(() => {
    if (!showMarkersRef.current) {
      setMarkers((m) => (m.length ? [] : m));
      return;
    }
    cancelAnimationFrame(markersRaf.current);
    markersRaf.current = requestAnimationFrame(() => {
      const d = doc();
      const win = d?.defaultView;
      if (!d?.body || !win) return;
      const vh = win.innerHeight;
      const vw = win.innerWidth;
      const out: Marker[] = [];
      d.body.querySelectorAll<HTMLElement>(MARKER_SELECTOR).forEach((el) => {
        const uid = el.getAttribute(UID_ATTR);
        if (!uid) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return;
        out.push({
          uid,
          kind: el.hasAttribute(HREF_ATTR) ? "atrelado" : el.tagName === "FORM" ? "form" : "a",
          top: Math.max(r.top, 8),
          left: Math.max(r.left, 0),
        });
      });
      setMarkers(out);
    });
  }, []);

  const refreshRect = useCallback(() => {
    refreshMarkers();
    const el = selectedRef.current;
    if (!el || !el.isConnected) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ uid: el.getAttribute(UID_ATTR) ?? "", top: r.top, left: r.left, width: r.width, height: r.height });
  }, [refreshMarkers]);

  useEffect(() => {
    refreshMarkers();
  }, [showMarkers, refreshMarkers]);

  const emitSelect = useCallback(() => {
    const el = selectedRef.current;
    onSelect(el && el.isConnected ? describe(el) : null);
    refreshRect();
  }, [onSelect, refreshRect]);

  const commit = useCallback(() => {
    const d = doc();
    if (!d) return;
    normalizePages(d);
    syncRuntime(d);
    const out = serialize(d);
    lastSerializedRef.current = out;
    onChange(out);
    onHiddenCount?.(countHidden(d));
    refreshMarkers();
  }, [onChange, onHiddenCount, refreshMarkers]);

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
    ensureCurrent(d);
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
  }, [baseHref, commit, emitSelect, ensureCurrent, onHiddenCount, refreshRect, select]);

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

  // O pai trocou a sub-página: aplica na canvas e solta a seleção se ela ficou fora.
  useEffect(() => {
    currentPageIdRef.current = currentPageId;
    const d = doc();
    if (!d?.body) return;
    ensureCurrent(d);
    const sel = selectedRef.current;
    if (sel && currentPageIdRef.current && pageOf(sel)?.getAttribute(PAGE_ATTR) !== currentPageIdRef.current) select(null);
    else refreshRect();
  }, [currentPageId, ensureCurrent, refreshRect, select]);

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

  const cmdSelectByUid = useCallback(
    (uid: string) => {
      const d = doc();
      if (!d) return;
      const el = elementByUid(d, uid);
      const pg = el ? pageOf(el)?.getAttribute(PAGE_ATTR) ?? null : null;
      if (pg && pg !== currentPageIdRef.current) {
        currentPageIdRef.current = pg;
        setCurrent(d, pg);
        onPageChangeRef.current?.(pg);
      }
      select(el);
      if (el) {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        // `scrollIntoView` dispara scroll no iframe (que já atualiza o rect),
        // mas não quando o elemento já está visível — garante o contorno.
        refreshRect();
      }
    },
    [refreshRect, select],
  );

  const cmdMutate = useCallback(
    (fn: (d: Document) => void, opts: { reindex?: boolean } = {}) => {
      const d = doc();
      if (!d) return;
      fn(d);
      if (opts.reindex) {
        assignUids(d);
        if (selectedUidRef.current) selectedRef.current = elementByUid(d, selectedUidRef.current);
      }
      ensureCurrent(d);
      commit();
      emitSelect();
    },
    [commit, emitSelect, ensureCurrent],
  );

  const cmdInsertHtml = useCallback(
    (markup: string) => {
      const d = doc();
      if (!d?.body || !markup.trim()) return;
      const tpl = d.createElement("template");
      tpl.innerHTML = markup;
      const nodes = Array.from(tpl.content.children) as HTMLElement[];
      if (!nodes.length) return;
      const anchor = selectedRef.current;
      const page = currentPageIdRef.current ? pageById(d, currentPageIdRef.current) : null;
      if (anchor?.isConnected && anchor.parentElement && anchor.parentElement !== d.documentElement && !anchor.hasAttribute(PAGE_ATTR)) {
        anchor.after(...nodes);
      } else if (page) {
        page.append(...nodes);
      } else {
        // Antes do script de runtime, se existir — ele fica por último.
        const runtime = d.body.querySelector(`:scope > script[${RUNTIME_ATTR}]`);
        if (runtime) runtime.before(...nodes);
        else d.body.append(...nodes);
      }
      assignUids(d);
      select(nodes[0]);
      nodes[0].scrollIntoView({ block: "center" });
      commit();
    },
    [commit, select],
  );

  useImperativeHandle(
    ref,
    (): CanvasHandle => ({
      setText: (text) => withSelected((el) => (el.textContent = text)),
      setLink: (href, target) =>
        withSelected((el) => {
          const uid = el.getAttribute(UID_ATTR);
          if (uid) setLink(el.ownerDocument, uid, { href, target });
        }),
      clearLink: () =>
        withSelected((el) => {
          const uid = el.getAttribute(UID_ATTR);
          if (uid) clearLink(el.ownerDocument, uid);
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
      selectByUid: cmdSelectByUid,
      mutate: cmdMutate,
      insertHtml: cmdInsertHtml,
    }),
    [withSelected, cmdDuplicate, cmdRemove, cmdMove, cmdSelectByUid, cmdMutate, cmdInsertHtml, select],
  );

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        title="Editor da página"
        sandbox="allow-same-origin allow-forms"
        className="block h-full w-full border-0 bg-white"
      />
      {/* Camada de seleção do pai — não intercepta cliques, só a toolbar e os marcadores. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {markers.map((m) =>
          m.uid === rect?.uid ? null : (
            <button
              key={m.uid}
              type="button"
              title={m.kind === "a" ? "Link — clique para selecionar" : m.kind === "form" ? "Formulário — clique para selecionar" : "Link atrelado — clique para selecionar"}
              onClick={() => cmdSelectByUid(m.uid)}
              className={`pointer-events-auto absolute z-10 inline-flex h-4 -translate-y-1/2 items-center gap-0.5 rounded px-1 text-[9px] font-semibold leading-none text-white shadow ${
                m.kind === "atrelado" ? "bg-violet-600" : m.kind === "form" ? "bg-amber-600" : "bg-accent"
              }`}
              style={{ top: m.top, left: m.left }}
            >
              <LinkIcon className="size-2.5" />
              {m.kind}
            </button>
          ),
        )}
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
