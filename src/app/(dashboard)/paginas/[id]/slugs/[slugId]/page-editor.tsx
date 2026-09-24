"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { CodeEditor } from "@/components/code-editor";
import { Inspector, type InspectorCallbacks, type InspectorTab, type LinkDestination } from "@/components/editor/inspector";
import { LayersPanel } from "@/components/editor/panels/layers-panel";
import { LinksPanel } from "@/components/editor/panels/links-panel";
import { PagesPanel } from "@/components/editor/panels/pages-panel";
import { SubPagesPanel, type SubPagesActions } from "@/components/editor/panels/subpages-panel";
import { WidgetsPanel } from "@/components/editor/panels/widgets-panel";
import { Rail, type RailPanel } from "@/components/editor/rail";
import { VisualCanvas, type CanvasHandle } from "@/components/editor/visual-canvas";
import { HtmlPreview } from "@/components/html-preview";
import {
  CodeIcon,
  DesktopIcon,
  EyeIcon,
  LinkIcon,
  MobileIcon,
  PlayIcon,
  PublishIcon,
  RedoIcon,
  TabletIcon,
  UndoIcon,
} from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INPUT_BASE, SELECT_BASE } from "@/components/ui/field";
import { buildLayers, parseHtml, type LayerNode, type SelectionInfo } from "@/lib/pages/html-editing";
import { extractLinks, mutateHtml, replaceAll, replaceDestination, type LinkEntry } from "@/lib/pages/links";
import { NEXT_STEP } from "@/lib/pages/runtime";
import { isFullDocument, wrapFragment } from "@/lib/pages/starter-template";
import {
  activateStep,
  deactivateStep,
  getFunnelMode,
  listPages,
  pageById,
  pageHref,
  previewFrom,
  setFunnelMode,
  setTriggers,
  startPage,
  type FunnelMode,
  type SubPage,
} from "@/lib/pages/subpages";
import {
  PAGE_KINDS,
  PAGE_KIND_LABELS,
  PAGE_STATUS_LABELS,
  type Page,
  type PageKind,
  type PageSlug,
  type PageSlugSummary,
  type PageStatus,
} from "@/lib/pages/types";
import type { ActionResult } from "@/lib/action-result";
import { AUTO_PLACEHOLDERS, PLACEHOLDER_FIELDS, applyPlaceholders, placeholderToken } from "@/lib/pages/placeholders";
import { APP_TZ } from "@/lib/time-zone";
import type { SaveEditorInput, SaveEditorResult } from "../../../actions";

/**
 * O que o editor faz com a página, sem saber onde ela mora: template
 * (pages/page_slugs, paginas/actions.ts) ou página de domínio (domains.site,
 * dominios/[id]/paginas/actions.ts). Vêm prontas (com `.bind`) da rota.
 */
export type EditorActions = {
  save: (input: SaveEditorInput) => Promise<SaveEditorResult>;
  createSlug: (rawSlug: string, title: string | null) => Promise<ActionResult<{ slugId: string }>>;
  /** Quem troca o id da slug ao renomear (página de domínio: id = path) devolve o novo. */
  renameSlug: (slugId: string, rawSlug: string) => Promise<ActionResult<{ slugId?: string }>>;
  toggleSlug: (slugId: string, active: boolean) => Promise<ActionResult>;
  deleteSlug: (slugId: string) => Promise<ActionResult>;
  deletePage: () => Promise<ActionResult>;
};

export type EditorNav = {
  backHref: string;
  backTitle: string;
  /** URL de uma slug, com `{slug}` no lugar do id (é trocado pelo id codificado). */
  slugHref: string;
  /** Para onde ir quando a página (ou a última slug) some. */
  afterDeleteHref: string;
};

/**
 * O editor de página em formato de construtor: topbar (Preview/Publish/Saved,
 * desfazer/refazer), barra de ícones + painel à esquerda (Pages, Widgets,
 * Layers, Links), canvas no meio (edição visual por clique OU código) e
 * inspetor à direita (Style/Settings).
 *
 * A edição visual grava de volta no MESMO HTML por slug — nada muda no modelo
 * nem no servidor. O estado local é a verdade enquanto se edita; o servidor só
 * entra ao salvar, com concorrência otimista (os `updated_at` voltam e são
 * guardados para o próximo save; em `conflict`, a tela avisa e oferece recarregar).
 *
 * Links: o painel Links e a árvore de camadas são derivados do HTML atual
 * (`parseHtml` → mesmos uids da canvas), então funcionam nos dois modos. As
 * trocas passam por `applyDocChange`: na canvas ao vivo quando ela está
 * montada (sem recarregar o iframe), ou sobre o HTML em modo código.
 */

type Device = "desktop" | "tablet" | "mobile";
type Mode = "visual" | "code";
const DEVICE_W: Record<Device, string> = { desktop: "100%", tablet: "820px", mobile: "390px" };
const OUTLINE_DEBOUNCE_MS = 250;

export function PageEditor({
  page,
  slugs,
  slug,
  domains,
  actions,
  nav,
  scope,
  placeholders,
}: {
  page: Page;
  slugs: PageSlugSummary[];
  slug: PageSlug;
  domains: string[];
  actions: EditorActions;
  nav: EditorNav;
  /** Template (biblioteca) ou página de um domínio. */
  scope: "template" | "domain";
  /** Valores dos marcadores no preview (página de domínio). Template: null, o preview mostra os marcadores crus. */
  placeholders: Record<string, string> | null;
}) {
  const router = useRouter();
  const slugHref = useCallback((id: string) => nav.slugHref.replace("{slug}", encodeURIComponent(id)), [nav.slugHref]);

  const [name, setName] = useState(page.name);
  const [kind, setKind] = useState<PageKind>(page.kind);
  const [status, setStatus] = useState<PageStatus>(page.status);
  const [content, setContent] = useState(slug.content);
  const [pageUpdatedAt, setPageUpdatedAt] = useState(page.updated_at);
  const [slugUpdatedAt, setSlugUpdatedAt] = useState(slug.updated_at);
  const [savedSnapshot, setSavedSnapshot] = useState({ name: page.name, kind: page.kind, status: page.status, content: slug.content });
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const [mode, setMode] = useState<Mode>("visual");
  const [previewing, setPreviewing] = useState(false);
  const [device, setDevice] = useState<Device>("desktop");
  const [previewBase, setPreviewBase] = useState<string>(domains[0] ?? "");
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("settings");
  const [hiddenCount, setHiddenCount] = useState(0);
  const [panel, setPanel] = useState<RailPanel | null>("pages");
  const [showMarkers, setShowMarkers] = useState(true);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState("");
  const [outline, setOutline] = useState<{ links: LinkEntry[]; layers: LayerNode[]; pages: SubPage[]; funnelMode: FunnelMode }>({
    links: [],
    layers: [],
    pages: [],
    funnelMode: "browser",
  });

  const [pending, startTransition] = useTransition();
  const [busy, startBusy] = useTransition();

  const canvasRef = useRef<CanvasHandle>(null);

  // ── Histórico (desfazer/refazer sobre o HTML) ──────────────────────────────
  // Refs só são tocadas em handlers/efeitos (nunca no render); os botões leem o
  // estado `undoRedo`. `contentRef` espelha o conteúdo para pegar o valor
  // anterior sem functional-updater (que o strict mode invoca 2x).
  const historyRef = useRef<{ past: string[]; future: string[]; lastAt: number }>({ past: [], future: [], lastAt: 0 });
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);
  const [undoRedo, setUndoRedo] = useState({ canUndo: false, canRedo: false });
  const syncUndoRedo = () => setUndoRedo({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });

  const updateContent = useCallback((next: string) => {
    const prev = contentRef.current;
    if (next === prev) return;
    const h = historyRef.current;
    const now = Date.now();
    if (now - h.lastAt > 500) {
      h.past.push(prev); // agrupa rajadas de <500ms
      if (h.past.length > 100) h.past.shift();
    }
    h.lastAt = now;
    h.future = [];
    contentRef.current = next;
    setContent(next);
    syncUndoRedo();
  }, []);
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    const prev = h.past.pop()!;
    h.future.unshift(contentRef.current);
    h.lastAt = 0;
    contentRef.current = prev;
    setContent(prev);
    syncUndoRedo();
  }, []);
  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    const next = h.future.shift()!;
    h.past.push(contentRef.current);
    h.lastAt = 0;
    contentRef.current = next;
    setContent(next);
    syncUndoRedo();
  }, []);
  const { canUndo, canRedo } = undoRedo;

  const dirtyMeta = name !== savedSnapshot.name || kind !== savedSnapshot.kind || status !== savedSnapshot.status;
  const dirtyContent = content !== savedSnapshot.content;
  const dirty = dirtyMeta || dirtyContent;
  const fullDoc = useMemo(() => isFullDocument(content), [content]);

  // ── Links + camadas, derivados do HTML atual ──────────────────────────────
  // Só no cliente (DOMParser) e com debounce: no modo código o CodeMirror
  // dispara a cada tecla. Efeito, não memo, para não divergir do SSR.
  useEffect(() => {
    const t = setTimeout(() => {
      const d = parseHtml(content);
      const pages = listPages(d);
      const root = currentPageId ? pageById(d, currentPageId) : null;
      setOutline({ links: extractLinks(d), layers: buildLayers(d, root), pages, funnelMode: getFunnelMode(d) });
      // Em modo código a canvas não está montada para escolher a sub-página:
      // cai na inicial (ou solta, se a slug voltou a ser página única).
      if (pages.length && (!currentPageId || !pages.some((p) => p.id === currentPageId))) setCurrentPageId(startPage(d)?.getAttribute("data-dop-page") ?? null);
      else if (!pages.length && currentPageId) setCurrentPageId(null);
    }, mode === "code" ? OUTLINE_DEBOUNCE_MS : 0); // no visual a mudança vem pronta da canvas
    return () => clearTimeout(t);
  }, [content, currentPageId, mode]);

  const save = useCallback(
    (override?: { status?: PageStatus }) => {
      if (pending) return;
      const nStatus = override?.status ?? status;
      startTransition(async () => {
        const result = await actions.save({
          page: { id: page.id, name, kind, status: nStatus, expectedUpdatedAt: pageUpdatedAt },
          slug: content !== savedSnapshot.content ? { id: slug.id, content, expectedUpdatedAt: slugUpdatedAt } : null,
        });
        if (!result.ok) {
          setMessage(
            result.reason === "conflict"
              ? { tone: "warning", text: "This page was saved somewhere else since you opened it. Reload to see the current version (what's on this screen will be discarded)." }
              : { tone: "danger", text: result.reason },
          );
          return;
        }
        setPageUpdatedAt(result.pageUpdatedAt);
        if (result.slugUpdatedAt) setSlugUpdatedAt(result.slugUpdatedAt);
        if (override?.status) setStatus(override.status);
        setSavedSnapshot({ name, kind, status: nStatus, content });
        setLastSavedAt(new Date());
        setMessage(null);
        router.refresh();
      });
    },
    [pending, actions, page.id, name, kind, status, pageUpdatedAt, content, savedSnapshot.content, slug.id, slugUpdatedAt, router],
  );

  // Atalhos: ⌘S salva, ⌘Z desfaz, ⌘⇧Z refaz. Captura para chegar antes do CodeMirror.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        save();
      } else if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save, undo, redo]);

  // Guarda de saída com alterações pendentes.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      if (!window.confirm("You have unsaved changes. Leave anyway?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  function run(task: () => Promise<{ ok: boolean; reason?: string }>, after?: () => void) {
    startBusy(async () => {
      const r = await task();
      if (!r.ok) {
        setMessage({ tone: "danger", text: r.reason ?? "Error." });
        return;
      }
      setMessage(null);
      after?.();
      router.refresh();
    });
  }

  function onNewSlug(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const value = String(new FormData(form).get("slug") ?? "");
    if (!value.trim()) return;
    startBusy(async () => {
      const r = await actions.createSlug(value, null);
      if (!r.ok) return setMessage({ tone: "danger", text: r.reason });
      form.reset();
      setMessage(null);
      router.push(slugHref(r.slugId));
    });
  }
  function onRenameSlug() {
    const value = window.prompt("New slug path:", slug.slug);
    if (value === null || value.trim() === slug.slug) return;
    startBusy(async () => {
      const r = await actions.renameSlug(slug.id, value);
      if (!r.ok) return setMessage({ tone: "danger", text: r.reason });
      setMessage(null);
      // Página de domínio: o id da slug é o path, então a URL muda junto.
      if (r.slugId && r.slugId !== slug.id) router.replace(slugHref(r.slugId));
      else router.refresh();
    });
  }
  function onDeleteSlug() {
    if (!window.confirm(`Remove the slug ${slug.slug}? Its HTML will be lost.`)) return;
    startBusy(async () => {
      const r = await actions.deleteSlug(slug.id);
      if (!r.ok) return setMessage({ tone: "danger", text: r.reason });
      const next = slugs.find((s) => s.id !== slug.id);
      router.push(next ? slugHref(next.id) : nav.afterDeleteHref);
    });
  }
  function onDeletePage() {
    const question =
      scope === "template"
        ? `Delete the template "${page.name}" and all its slugs? The copies domains already have won't change.`
        : `Remove the page "${page.name}" from this domain? Its HTML will be lost.`;
    if (!window.confirm(question)) return;
    startBusy(async () => {
      const r = await actions.deletePage();
      if (!r.ok) return setMessage({ tone: "danger", text: r.reason });
      dirtyRef.current = false;
      router.push(nav.afterDeleteHref);
    });
  }

  const enterPreview = (on: boolean) => {
    if (on) {
      canvasRef.current?.clearSelection();
      setSelection(null);
      // O preview começa na etapa que está na canvas (só no preview; nada é gravado).
      const c = contentRef.current;
      setPreviewDoc(currentPageId && isFullDocument(c) ? mutateHtml(c, (d) => previewFrom(d, currentPageId)) : c);
    }
    setPreviewing(on);
  };
  const switchMode = (m: Mode) => {
    if (m === "code") {
      canvasRef.current?.clearSelection();
      setSelection(null);
    }
    setMode(m);
  };

  const callbacks: InspectorCallbacks = {
    setText: (v) => canvasRef.current?.setText(v),
    setLink: (href, target) => canvasRef.current?.setLink(href, target),
    clearLink: () => canvasRef.current?.clearLink(),
    setHidden: (v) => canvasRef.current?.setHidden(v),
    setStyle: (p, v) => canvasRef.current?.setStyleProp(p, v),
  };

  // ── Painéis: trocas de link, seleção pela lista, inserir widget ───────────
  /** Aplica uma mudança no documento: na canvas ao vivo se montada, senão no HTML. */
  const applyDocChange = useCallback(
    (fn: (doc: Document) => void, opts?: { reindex?: boolean }) => {
      const c = canvasRef.current;
      if (c) c.mutate(fn, opts);
      else if (isFullDocument(contentRef.current)) updateContent(mutateHtml(contentRef.current, fn));
    },
    [updateContent],
  );

  /** Garante a canvas montada (sai do preview / do código) e roda `fn` nela. */
  const withCanvas = useCallback(
    (fn: (c: CanvasHandle) => void) => {
      const now = canvasRef.current;
      if (now) return fn(now);
      if (!isFullDocument(contentRef.current)) return;
      setPreviewing(false);
      setMode("visual");
      // A canvas monta no próximo commit do React e escreve o documento no
      // efeito de montagem — antes deste timeout rodar.
      setTimeout(() => {
        const c = canvasRef.current;
        if (c) fn(c);
      }, 0);
    },
    [],
  );

  const focusUid = useCallback(
    (uid: string) => {
      setInspectorTab("settings");
      withCanvas((c) => c.selectByUid(uid));
    },
    [withCanvas],
  );

  const insertWidget = useCallback((html: string) => withCanvas((c) => c.insertHtml(html)), [withCanvas]);

  const replaceLinks = useCallback((from: string, to: string) => applyDocChange((d) => void replaceDestination(d, from, to)), [applyDocChange]);
  const replaceAllLinks = useCallback((to: string) => applyDocChange((d) => void replaceAll(d, to)), [applyDocChange]);

  const togglePanel = (p: RailPanel) => setPanel((cur) => (cur === p ? null : p));

  // ── Funil (Pre Lander → Lander → Backredirect) ─────────────────────────────
  // Ativar/desativar muda a estrutura do body → reindexa uids. Quem escolhe a
  // etapa mostrada é `currentPageId`; a canvas cai na inicial se ela sumir.
  const subPages: SubPagesActions = {
    select: (id) => {
      setCurrentPageId(id);
      canvasRef.current?.clearSelection();
      setSelection(null);
    },
    activate: (kind) => {
      let created = "";
      applyDocChange((d) => void (created = activateStep(d, kind)), { reindex: true });
      if (created) setCurrentPageId(created);
    },
    deactivate: (kind) => applyDocChange((d) => deactivateStep(d, kind), { reindex: true }),
    setTriggers: (id, t) => applyDocChange((d) => setTriggers(d, id, t)),
    setMode: (m) => applyDocChange((d) => setFunnelMode(d, m)),
  };

  const activeSteps = outline.pages.filter((p) => p.active);
  const destinations: LinkDestination[] = [
    ...(activeSteps.length > 1 ? [{ label: "Next step (#next-step)", href: NEXT_STEP, group: "This slug's funnel (same URL)" }] : []),
    ...activeSteps.filter((p) => p.id !== currentPageId).map((p) => ({ label: p.name, href: pageHref(p.id), group: "This slug's funnel (same URL)" })),
    ...slugs.filter((s) => s.id !== slug.id && s.is_active).map((s) => ({ label: s.slug, href: s.slug, group: "This page's slugs (changes the URL)" })),
  ];

  const baseHref = previewBase ? `https://${previewBase}/` : undefined;
  const savedLabel = pending ? "Saving…" : dirty ? "Unsaved" : lastSavedAt ? `Saved ${lastSavedAt.toLocaleTimeString("en-US", { timeZone: APP_TZ })}` : "Saved";

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col gap-2">
      {/* Topbar */}
      <header className="flex flex-wrap items-center gap-2">
        <Link href={nav.backHref} title={nav.backTitle} className="text-sm text-muted hover:text-foreground">
          ←
        </Link>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Page name" className={`${INPUT_BASE} h-9 w-52 font-medium`} />
        <Badge tone={PAGE_STATUS_TONE[savedSnapshot.status]}>{PAGE_STATUS_LABELS[savedSnapshot.status]}</Badge>
        <span className="text-xs text-muted">· {savedLabel}</span>
        {scope === "domain" ? (
          <span className="text-xs text-muted" title="Page exclusive to this domain. The template doesn't change when you edit here.">
            · page on {domains[0]}
          </span>
        ) : (
          <span className="text-xs text-muted" title="Template: domains get copies. Editing here doesn't change the copies that already exist.">
            · template
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <IconButton title="Undo (⌘Z)" onClick={undo} disabled={!canUndo}>
            <UndoIcon className="size-4" />
          </IconButton>
          <IconButton title="Redo (⌘⇧Z)" onClick={redo} disabled={!canRedo}>
            <RedoIcon className="size-4" />
          </IconButton>
          <PlaceholdersMenu values={placeholders} />
          <Button size="sm" variant={previewing ? "primary" : "secondary"} onClick={() => enterPreview(!previewing)}>
            <PlayIcon className="size-4" /> Preview
          </Button>
          <Button size="sm" onClick={() => save(status === "PUBLISHED" ? undefined : { status: "PUBLISHED" })} disabled={pending}>
            <PublishIcon className="size-4" /> {status === "PUBLISHED" ? "Save" : "Publish"}
          </Button>
        </div>
      </header>

      {message ? (
        <Alert tone={message.tone}>
          <span>{message.text}</span>
          {message.tone === "warning" ? (
            <button type="button" className="ml-2 underline" onClick={() => window.location.reload()}>
              Reload
            </button>
          ) : null}
        </Alert>
      ) : null}

      {/* Corpo: rail + painel | canvas | inspetor */}
      <div className="flex min-h-0 flex-1 gap-2">
        <div className="hidden shrink-0 gap-2 md:flex">
          <Rail active={panel} onSelect={togglePanel} badges={{ links: outline.links.length, funnel: activeSteps.length > 1 ? activeSteps.length : 0 }} />
          {panel ? (
            <aside className="flex w-64 shrink-0 flex-col rounded-xl border border-border bg-surface">
              {panel === "pages" ? (
                <PagesPanel
                  slugHref={slugHref}
                  slugs={slugs}
                  currentSlugId={slug.id}
                  currentActive={slug.is_active}
                  busy={busy}
                  onNewSlug={onNewSlug}
                  onRename={onRenameSlug}
                  onToggle={() => run(() => actions.toggleSlug(slug.id, !slug.is_active))}
                  onRemove={onDeleteSlug}
                />
              ) : panel === "funnel" ? (
                <SubPagesPanel pages={outline.pages} currentId={currentPageId} mode={outline.funnelMode} canEdit={fullDoc} actions={subPages} />
              ) : panel === "widgets" ? (
                <WidgetsPanel canInsert={fullDoc} onInsert={insertWidget} />
              ) : panel === "layers" ? (
                <LayersPanel layers={outline.layers} selectedUid={selection?.uid ?? null} onSelect={focusUid} />
              ) : (
                <LinksPanel
                  links={outline.links}
                  selectedUid={selection?.uid ?? null}
                  canEdit={fullDoc}
                  onSelect={focusUid}
                  onReplace={replaceLinks}
                  onReplaceAll={replaceAllLinks}
                />
              )}
            </aside>
          ) : null}
        </div>

        {/* Canvas */}
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="min-h-0 flex-1 overflow-auto bg-foreground/5 p-3">
            <div
              className="mx-auto h-full min-h-[24rem] overflow-hidden rounded-lg border border-border bg-white shadow-sm"
              style={{ width: DEVICE_W[device], maxWidth: "100%" }}
            >
              {previewing ? (
                <HtmlPreview
                  html={placeholders ? applyPlaceholders(previewDoc || content, placeholders) : previewDoc || content}
                  baseHref={baseHref}
                  className="h-full w-full"
                />
              ) : mode === "code" ? (
                <div className="h-full bg-surface">
                  <CodeEditor value={content} onChange={updateContent} placeholderValues={placeholders} />
                </div>
              ) : fullDoc ? (
                <VisualCanvas
                  ref={canvasRef}
                  html={content}
                  baseHref={baseHref}
                  onChange={updateContent}
                  onSelect={setSelection}
                  onHiddenCount={setHiddenCount}
                  showMarkers={showMarkers}
                  currentPageId={currentPageId}
                  onPageChange={setCurrentPageId}
                  placeholderValues={placeholders}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <p className="text-sm font-medium">Visual editing needs a complete HTML document.</p>
                  <p className="max-w-sm text-xs text-muted">This content is a fragment. Wrap it in a document to edit it on the canvas, or use Code mode.</p>
                  <Button size="sm" onClick={() => updateContent(wrapFragment(content, { title: name }))}>
                    Wrap fragment in a document
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Barra inferior: dispositivo, modo, base do preview, ocultos */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              <Seg active={device === "desktop"} title="Desktop" onClick={() => setDevice("desktop")}>
                <DesktopIcon className="size-4" />
              </Seg>
              <Seg active={device === "tablet"} title="Tablet" onClick={() => setDevice("tablet")}>
                <TabletIcon className="size-4" />
              </Seg>
              <Seg active={device === "mobile"} title="Mobile" onClick={() => setDevice("mobile")}>
                <MobileIcon className="size-4" />
              </Seg>
            </div>

            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              <Seg active={mode === "visual" && !previewing} title="Visual" onClick={() => switchMode("visual")}>
                <EyeIcon className="size-4" />
              </Seg>
              <Seg active={mode === "code" && !previewing} title="Code" onClick={() => switchMode("code")}>
                <CodeIcon className="size-4" />
              </Seg>
            </div>

            <select value={previewBase} onChange={(e) => setPreviewBase(e.target.value)} aria-label="Base domain" className={`${SELECT_BASE} h-8 w-40 text-xs`}>
              <option value="">No base domain</option>
              {domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>

            {mode === "visual" && !previewing ? (
              <button
                type="button"
                onClick={() => setShowMarkers((v) => !v)}
                aria-pressed={showMarkers}
                title={showMarkers ? "Hide link markers" : "Show link markers"}
                className={`ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
                  showMarkers ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-muted hover:text-foreground"
                }`}
              >
                <LinkIcon className="size-3.5" /> {outline.links.length} {outline.links.length === 1 ? "link" : "links"}
              </button>
            ) : null}
            {hiddenCount > 0 && mode === "visual" && !previewing ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                <EyeIcon className="size-3.5" /> {hiddenCount} hidden
              </span>
            ) : null}
          </div>
        </section>

        {/* Inspetor */}
        <Inspector
          tab={inspectorTab}
          onTab={setInspectorTab}
          selection={previewing ? null : selection}
          callbacks={callbacks}
          destinations={destinations}
          placeholderValues={placeholders}
          pageSettings={
            <PageSettings
              name={name}
              kind={kind}
              status={status}
              slugPath={slug.slug}
              onKind={setKind}
              onStatus={setStatus}
              onDeletePage={onDeletePage}
              busy={busy}
            />
          }
        />
      </div>
    </div>
  );
}

function PageSettings({
  kind,
  status,
  slugPath,
  onKind,
  onStatus,
  onDeletePage,
  busy,
}: {
  name: string;
  kind: PageKind;
  status: PageStatus;
  slugPath: string;
  onKind: (k: PageKind) => void;
  onStatus: (s: PageStatus) => void;
  onDeletePage: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">Nothing selected. Click an element on the canvas to edit it, or adjust the page:</p>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Slug</span>
        <code className="rounded-md bg-foreground/5 px-2 py-1.5 font-mono text-xs">{slugPath}</code>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Type</span>
        <select value={kind} onChange={(e) => onKind(e.target.value as PageKind)} className={`${SELECT_BASE} w-full`}>
          {PAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {PAGE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Status</span>
        <select value={status} onChange={(e) => onStatus(e.target.value as PageStatus)} className={`${SELECT_BASE} w-full`}>
          <option value="DRAFT">{PAGE_STATUS_LABELS.DRAFT}</option>
          <option value="PUBLISHED">{PAGE_STATUS_LABELS.PUBLISHED}</option>
          <option value="ARCHIVED">{PAGE_STATUS_LABELS.ARCHIVED}</option>
        </select>
      </label>
      {status !== "PUBLISHED" ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">Only Published pages are served on domains.</p>
      ) : null}
      <Button size="sm" variant="danger" onClick={onDeletePage} disabled={busy} className="mt-2 w-full">
        Delete page
      </Button>
    </div>
  );
}

/**
 * Lista dos marcadores {{chave}} com botão de copiar. Na página de domínio
 * mostra o valor que entra no lugar; no template, um exemplo.
 */
function PlaceholdersMenu({ values }: { values: Record<string, string> | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  const rows = [
    ...PLACEHOLDER_FIELDS.map((f) => ({ key: f.key, label: f.label, hint: f.example })),
    ...AUTO_PLACEHOLDERS.map((f) => ({ key: f.key, label: f.label, hint: f.note })),
  ];
  const copy = (key: string) => {
    void navigator.clipboard?.writeText(placeholderToken(key)).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    });
  };
  return (
    <details className="relative">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg border border-border px-2.5 text-xs text-muted hover:text-foreground">
        {"{{ }}"} Placeholders
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-80 rounded-xl border border-border bg-surface p-2 text-xs shadow-lg">
        <p className="px-1 pb-2 text-muted">
          Write the placeholder in the text or in a link (e.g. <code>mailto:{"{{company.email}}"}</code>). When serving, the domain replaces it with its value;
          language and date follow the visitor&apos;s browser (the preview shows English).
        </p>
        <ul className="max-h-72 overflow-auto">
          {rows.map((r) => {
            const value = values ? values[r.key] : undefined;
            return (
              <li key={r.key} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-foreground/5">
                <button type="button" onClick={() => copy(r.key)} className="font-mono text-accent" title="Copy">
                  {placeholderToken(r.key)}
                </button>
                <span className="min-w-0 flex-1 truncate text-muted" title={value ?? r.hint}>
                  {copied === r.key ? "copied" : values ? value || "(empty on this domain)" : r.label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}

function IconButton({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Seg({ active, title, onClick, children }: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-md transition-colors ${active ? "bg-accent/10 text-accent" : "text-muted hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}
