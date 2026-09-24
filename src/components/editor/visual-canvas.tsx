"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { PlaceholderList, suggestKey } from "@/components/editor/placeholder-suggest";
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
import { insertPlaceholder, openPlaceholderAt, suggestPlaceholders, type PlaceholderOption } from "@/lib/pages/placeholders";
import { syncRuntime } from "@/lib/pages/runtime";
import { normalizePages, pageById, pageOf, setCurrent, startPage } from "@/lib/pages/subpages";

/**
 * Link markers on the canvas (like the reference builder's "markers"):
 * one chip per visible link, drawn by the parent over the iframe. Clicking the
 * chip selects the element. Recomputed on every change/scroll, via rAF.
 */
type Marker = { uid: string; kind: "a" | "form" | "bound"; top: number; left: number };
const MARKER_SELECTOR = `a[href], area[href], form[action], [${HREF_ATTR}]`;

/**
 * The visual editing canvas. A SAME-ORIGIN iframe (sandbox="allow-same-origin",
 * without allow-scripts): the parent reads and changes the user's DOM, and the page's scripts
 * stay inert during editing. The selection (outline + toolbar) is drawn
 * HERE in the parent, over the iframe, so the user's document stays clean — what
 * gets saved comes out clean through `serialize`.
 *
 * The iframe is only reloaded when the HTML changes FROM OUTSIDE (code, slug switch):
 * visual edits update the parent's `html` through `onChange`, and that round trip is
 * ignored (compared with the last serialize) so the caret/selection is not lost.
 */

export type CanvasHandle = {
  setText(text: string): void;
  /** Sets the selected element's link (native or bound). An empty `href` removes it. */
  setLink(href: string, target?: string): void;
  clearLink(): void;
  setHidden(hidden: boolean): void;
  setStyleProp(prop: keyof SelectionStyle, value: string): void;
  duplicate(): void;
  remove(): void;
  move(dir: "up" | "down"): void;
  clearSelection(): void;
  /** Selects by uid (Links/Layers panels) and scrolls to the element. */
  selectByUid(uid: string): void;
  /**
   * Runs `fn` on the LIVE document (without reloading the iframe), reindexes if the
   * structure changed and saves. This is the panels' entry point for bulk changes.
   */
  mutate(fn: (doc: Document) => void, opts?: { reindex?: boolean }): void;
  /** Inserts HTML after the selected element (or at the end of the body) and selects it. */
  insertHtml(markup: string): void;
};

type Rect = { uid: string; top: number; left: number; width: number; height: number };

/** Placeholder list opened by "{{" in the text being edited: where the "{{" is and where the list shows up. */
type Suggest = { el: HTMLElement; node: Text; from: number; caret: number; items: PlaceholderOption[]; index: number; top: number; left: number };
const SUGGEST_W = 288;
const SUGGEST_H = 232;

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
    /** Shows a chip over each link (a / form / bound). */
    showMarkers?: boolean;
    /** Sub-page the canvas shows (null on a single-page slug). */
    currentPageId?: string | null;
    /** The canvas switched sub-page on its own (selection on another page, page removed…). */
    onPageChange?: (id: string | null) => void;
    /** Placeholder values (domain page), shown in the "{{" list. Template: null. */
    placeholderValues?: Record<string, string> | null;
  }
>(function VisualCanvas({ html, baseHref, onChange, onSelect, onHiddenCount, showMarkers = false, currentPageId = null, onPageChange, placeholderValues = null }, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const selectedRef = useRef<HTMLElement | null>(null);
  const selectedUidRef = useRef<string | null>(null);
  // Start at the incoming html: the JSX srcDoc is stable (it does not reload on every
  // edit); reloads from external changes go through the effect below.
  const lastSerializedRef = useRef<string>(html);
  const [rect, setRect] = useState<Rect | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const showMarkersRef = useRef(showMarkers);
  useEffect(() => {
    showMarkersRef.current = showMarkers;
  }, [showMarkers]);

  const doc = () => iframeRef.current?.contentDocument ?? null;

  // ── Current sub-page ───────────────────────────────────────────────────────
  // The canvas shows ONE sub-page at a time (data-dop-current attribute, editor
  // only). The parent sends the desired one; if it no longer exists, it falls back to the
  // start page and reports it. `ensureCurrent` runs after hydrating and after each structural mutation.
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
          kind: el.hasAttribute(HREF_ATTR) ? "bound" : el.tagName === "FORM" ? "form" : "a",
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

  // ── "{{" in the text being edited: placeholder list at the caret ───────────
  const suggestRef = useRef<Suggest | null>(null);
  const [suggest, setSuggestState] = useState<Suggest | null>(null);
  const setSuggest = useCallback((s: Suggest | null) => {
    suggestRef.current = s;
    setSuggestState(s);
  }, []);

  /** Rereads the text before the caret of the element being edited and opens/closes/updates the list. */
  const refreshSuggest = useCallback(
    (el: HTMLElement) => {
      const d = el.ownerDocument;
      const sel = d.getSelection();
      const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const node = r?.startContainer;
      if (!r || !r.collapsed || !node || node.nodeType !== 3 || !el.contains(node)) return setSuggest(null);
      const at = openPlaceholderAt((node.nodeValue ?? "").slice(0, r.startOffset));
      const items = at ? suggestPlaceholders(at.query) : [];
      if (!at || !items.length) return setSuggest(null);
      const box = r.getBoundingClientRect();
      const anchor = box.height ? box : el.getBoundingClientRect();
      const vw = d.defaultView?.innerWidth ?? 800;
      const vh = d.defaultView?.innerHeight ?? 600;
      const top = anchor.bottom + 4 + SUGGEST_H > vh ? Math.max(anchor.top - SUGGEST_H - 4, 4) : anchor.bottom + 4;
      const left = Math.max(4, Math.min(anchor.left, vw - SUGGEST_W - 4));
      const prev = suggestRef.current;
      const index = prev && prev.node === node && prev.from === at.from && prev.items.length === items.length ? Math.min(prev.index, items.length - 1) : 0;
      setSuggest({ el, node: node as Text, from: at.from, caret: r.startOffset, items, index, top, left });
    },
    [setSuggest],
  );

  const select = useCallback(
    (el: HTMLElement | null) => {
      selectedRef.current = el;
      selectedUidRef.current = el?.getAttribute(UID_ATTR) ?? null;
      emitSelect();
    },
    [emitSelect],
  );

  /** Replaces the typed "{{…" with the chosen placeholder; the caret ends up after it. */
  const pickSuggest = useCallback(
    (key: string) => {
      const s = suggestRef.current;
      if (!s || !s.node.isConnected) return setSuggest(null);
      const r = insertPlaceholder(s.node.nodeValue ?? "", s.from, s.caret, key);
      s.node.nodeValue = r.text;
      setSuggest(null);
      if (s.el.isContentEditable) {
        const d = s.node.ownerDocument;
        const range = d.createRange();
        range.setStart(s.node, r.caret);
        range.collapse(true);
        const sel = d.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } else {
        commit(); // editing had already ended (blur): save now
      }
    },
    [commit, setSuggest],
  );

  // ── Load/rehydrate the document in the iframe ──────────────────────────────
  const hydrate = useCallback(() => {
    const d = doc();
    if (!d || !d.body) return;
    injectCanvasChrome(d, baseHref);
    assignUids(d);
    ensureCurrent(d);
    onHiddenCount?.(countHidden(d));

    const onClick = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[contenteditable="true"]')) return; // let the caret be positioned
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
      const win = el.ownerDocument.defaultView;
      const onSel = () => refreshSuggest(el);
      const closeSuggest = () => setSuggest(null);
      const finish = () => {
        el.removeAttribute("contenteditable");
        el.removeEventListener("blur", finish);
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("input", onSel);
        el.ownerDocument.removeEventListener("selectionchange", onSel);
        win?.removeEventListener("scroll", closeSuggest, true);
        setSuggest(null);
        commit();
        if (selectedRef.current === el) emitSelect();
      };
      const onKey = (ev: KeyboardEvent) => {
        // Placeholder list open: arrows, Enter/Tab and Esc belong to it.
        const s = suggestRef.current;
        const k = s ? suggestKey(ev.key, s.index, s.items.length) : null;
        if (s && k !== null) {
          ev.preventDefault();
          if (k === "pick") pickSuggest(s.items[s.index].key);
          else if (k === "close") setSuggest(null);
          else setSuggest({ ...s, index: k });
          return;
        }
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          el.blur();
        }
      };
      el.addEventListener("blur", finish);
      el.addEventListener("keydown", onKey);
      el.addEventListener("input", onSel);
      el.ownerDocument.addEventListener("selectionchange", onSel);
      win?.addEventListener("scroll", closeSuggest, true);
      select(el);
    };
    const block = (e: Event) => e.preventDefault();

    d.addEventListener("click", onClick, true);
    d.addEventListener("dblclick", onDblClick, true);
    d.addEventListener("submit", block, true);
    d.defaultView?.addEventListener("scroll", refreshRect, true);

    // Finds the previous selection again (after an external reload).
    if (selectedUidRef.current) select(elementByUid(d, selectedUidRef.current));
    else refreshRect();
  }, [baseHref, commit, emitSelect, ensureCurrent, onHiddenCount, pickSuggest, refreshRect, refreshSuggest, select, setSuggest]);

  // Writes the markup into the iframe and hydrates right away. document.open/write/close is
  // synchronous and does not depend on the load event (which is unreliable with srcDoc).
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

  // Loads the initial document once.
  useEffect(() => {
    lastSerializedRef.current = html;
    writeDoc(html);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reloads only when the html comes from outside (≠ our last serialize).
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

  // The parent switched the sub-page: apply it to the canvas and drop the selection if it ended up outside.
  useEffect(() => {
    currentPageIdRef.current = currentPageId;
    const d = doc();
    if (!d?.body) return;
    ensureCurrent(d);
    const sel = selectedRef.current;
    if (sel && currentPageIdRef.current && pageOf(sel)?.getAttribute(PAGE_ATTR) !== currentPageIdRef.current) select(null);
    else refreshRect();
  }, [currentPageId, ensureCurrent, refreshRect, select]);

  // ── Commands (used by the inspector via the handle and by the toolbar) ─────
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
        // `scrollIntoView` fires scroll in the iframe (which already updates the rect),
        // but not when the element is already visible — this ensures the outline.
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
        // Before the runtime script, if there is one — it stays last.
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
        title="Page editor"
        sandbox="allow-same-origin allow-forms"
        className="block h-full w-full border-0 bg-white"
      />
      {/* The parent's selection layer — does not intercept clicks, only the toolbar and markers do. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {markers.map((m) =>
          m.uid === rect?.uid ? null : (
            <button
              key={m.uid}
              type="button"
              title={m.kind === "a" ? "Link — click to select" : m.kind === "form" ? "Form — click to select" : "Bound link — click to select"}
              onClick={() => cmdSelectByUid(m.uid)}
              className={`pointer-events-auto absolute z-10 inline-flex h-4 -translate-y-1/2 items-center gap-0.5 rounded px-1 text-[9px] font-semibold leading-none text-white shadow ${
                m.kind === "bound" ? "bg-violet-600" : m.kind === "form" ? "bg-amber-600" : "bg-accent"
              }`}
              style={{ top: m.top, left: m.left }}
            >
              <LinkIcon className="size-2.5" />
              {m.kind}
            </button>
          ),
        )}
        {suggest ? (
          <div className="pointer-events-auto absolute z-20" style={{ top: suggest.top, left: suggest.left, width: SUGGEST_W }}>
            <PlaceholderList
              items={suggest.items}
              index={suggest.index}
              values={placeholderValues}
              onPick={pickSuggest}
              onHover={(i) => suggestRef.current && setSuggest({ ...suggestRef.current, index: i })}
              className="w-full"
            />
          </div>
        ) : null}
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
