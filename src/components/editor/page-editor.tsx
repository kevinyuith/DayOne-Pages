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
  addVersion,
  deactivateStep,
  getFunnelMode,
  listPages,
  pageAsVersion,
  pageById,
  pageHref,
  previewFrom,
  removeVersion,
  replaceVersionContent,
  setFunnelMode,
  setTriggers,
  setWeight,
  splitEvenly,
  startPage,
  type FunnelMode,
  type SubPage,
} from "@/lib/pages/subpages";
import {
  PAGE_KIND_LABELS,
  TEMPLATE_KINDS,
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
import { templateRootHtml, type SaveEditorInput, type SaveEditorResult } from "@/app/(dashboard)/templates/actions";

/**
 * What the editor does with the page, without knowing where it lives: template
 * (pages/page_slugs, templates/actions.ts), funnel page (pages.funnels,
 * funnels/actions.ts) or domain page (domains.site,
 * domains/[id]/pages/actions.ts). They come ready-made (with `.bind`) from the route.
 */
export type EditorActions = {
  save: (input: SaveEditorInput) => Promise<SaveEditorResult>;
  createSlug: (rawSlug: string, title: string | null) => Promise<ActionResult<{ slugId: string }>>;
  /** Whoever changes the slug id on rename (domain page: id = path) returns the new one. */
  renameSlug: (slugId: string, rawSlug: string) => Promise<ActionResult<{ slugId?: string }>>;
  toggleSlug: (slugId: string, active: boolean) => Promise<ActionResult>;
  deleteSlug: (slugId: string) => Promise<ActionResult>;
  deletePage: () => Promise<ActionResult>;
};

export type EditorNav = {
  backHref: string;
  backTitle: string;
  /** URL of a slug, with `{slug}` in place of the id (replaced by the encoded id). */
  slugHref: string;
  /** Where to go when the page (or the last slug) goes away. */
  afterDeleteHref: string;
};

/**
 * The page editor in builder form: topbar (Preview/Publish/Saved,
 * undo/redo), icon bar + panel on the left (Pages, Widgets,
 * Layers, Links), canvas in the middle (visual click editing OR code) and
 * inspector on the right (Style/Settings).
 *
 * Visual editing writes back into the SAME HTML per slug — nothing changes in the model
 * or on the server. Local state is the truth while editing; the server only
 * comes in on save, with optimistic concurrency (the `updated_at` values come back and are
 * kept for the next save; on `conflict`, the screen warns and offers to reload).
 *
 * Links: the Links panel and the layer tree are derived from the current HTML
 * (`parseHtml` → the same uids as the canvas), so they work in both modes. The
 * changes go through `applyDocChange`: on the live canvas when it is
 * mounted (without reloading the iframe), or on the HTML in code mode.
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
  templates = [],
}: {
  page: Page;
  slugs: PageSlugSummary[];
  slug: PageSlug;
  domains: string[];
  actions: EditorActions;
  nav: EditorNav;
  /** Template (library), funnel page (pages.funnels) or a domain's page. */
  scope: "template" | "funnel" | "domain";
  /** Placeholder values in the preview (domain page). Template: null, the preview shows the raw placeholders. */
  placeholders: Record<string, string> | null;
  /** Templates that can become a funnel sample ("From a template…"). */
  templates?: { id: string; name: string }[];
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

  // ── History (undo/redo over the HTML) ──────────────────────────────────────
  // Refs are only touched in handlers/effects (never during render); the buttons read the
  // `undoRedo` state. `contentRef` mirrors the content to get the previous
  // value without a functional updater (which strict mode invokes twice).
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
      h.past.push(prev); // groups bursts of <500ms
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

  // ── Links + layers, derived from the current HTML ──────────────────────────
  // Client only (DOMParser) and debounced: in code mode CodeMirror
  // fires on every keystroke. An effect, not a memo, so it does not diverge from SSR.
  useEffect(() => {
    const t = setTimeout(() => {
      const d = parseHtml(content);
      const pages = listPages(d);
      const root = currentPageId ? pageById(d, currentPageId) : null;
      setOutline({ links: extractLinks(d), layers: buildLayers(d, root), pages, funnelMode: getFunnelMode(d) });
      // In code mode the canvas is not mounted to pick the sub-page:
      // fall back to the start page (or drop it, if the slug is a single page again).
      if (pages.length && (!currentPageId || !pages.some((p) => p.id === currentPageId))) setCurrentPageId(startPage(d)?.getAttribute("data-dop-page") ?? null);
      else if (!pages.length && currentPageId) setCurrentPageId(null);
    }, mode === "code" ? OUTLINE_DEBOUNCE_MS : 0); // in visual mode the change comes ready from the canvas
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

  // Shortcuts: ⌘S saves, ⌘Z undoes, ⌘⇧Z redoes. Capture phase to get there before CodeMirror.
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

  // Leave guard when there are unsaved changes.
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
      // Domain page: the slug id is the path, so the URL changes with it.
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
        : scope === "funnel"
          ? `Remove the page "${page.name}" from the funnel? Its HTML will be lost. Copies on domains stay, but stop getting traffic.`
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
      // The preview starts at the step shown on the canvas (preview only; nothing is saved).
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

  // ── Panels: link changes, selection from the list, widget insertion ────────
  /** Applies a change to the document: on the live canvas if mounted, otherwise on the HTML. */
  const applyDocChange = useCallback(
    (fn: (doc: Document) => void, opts?: { reindex?: boolean }) => {
      const c = canvasRef.current;
      if (c) c.mutate(fn, opts);
      else if (isFullDocument(contentRef.current)) updateContent(mutateHtml(contentRef.current, fn));
    },
    [updateContent],
  );

  /** Ensures the canvas is mounted (leaves preview / code) and runs `fn` on it. */
  const withCanvas = useCallback(
    (fn: (c: CanvasHandle) => void) => {
      const now = canvasRef.current;
      if (now) return fn(now);
      if (!isFullDocument(contentRef.current)) return;
      setPreviewing(false);
      setMode("visual");
      // The canvas mounts on React's next commit and writes the document in its
      // mount effect — before this timeout runs.
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

  // ── Funnel (Pre Lander → Lander → Backredirect, with samples) ──────────────
  // Structural changes reindex uids. `currentPageId` decides which sample is
  // shown; the canvas falls back to the start page if it goes away.
  const showCreated = (created: string) => created && setCurrentPageId(created);
  const subPages: SubPagesActions = {
    select: (id) => {
      setCurrentPageId(id);
      canvasRef.current?.clearSelection();
      setSelection(null);
    },
    activate: (kind) => {
      let created = "";
      applyDocChange((d) => void (created = activateStep(d, kind)), { reindex: true });
      showCreated(created);
    },
    deactivate: (kind) => applyDocChange((d) => deactivateStep(d, kind), { reindex: true }),
    addVersion: (kind, opts) => {
      let created = "";
      const html = opts.html !== undefined ? pageAsVersion(opts.html) : undefined;
      applyDocChange((d) => void (created = addVersion(d, kind, { from: opts.from, html })), { reindex: true });
      showCreated(created);
    },
    removeVersion: (id) => applyDocChange((d) => removeVersion(d, id), { reindex: true }),
    replaceVersion: (id, html) => {
      const content = pageAsVersion(html);
      applyDocChange((d) => replaceVersionContent(d, id, content), { reindex: true });
      setCurrentPageId(id);
    },
    setWeight: (id, w) => applyDocChange((d) => setWeight(d, id, w)),
    splitEvenly: (kind) => applyDocChange((d) => splitEvenly(d, kind)),
    setTriggers: (ids, t) => applyDocChange((d) => ids.forEach((id) => setTriggers(d, id, t))),
    setMode: (m) => applyDocChange((d) => setFunnelMode(d, m)),
    loadTemplate: templateRootHtml,
  };

  const activeSteps = outline.pages.filter((p) => p.active);
  // Direct destination only for single-sample steps: with an A/B test, the server serves just one and the link could point to one that was not drawn.
  const directSteps = activeSteps.filter((p) => activeSteps.filter((q) => q.kind === p.kind).length === 1);
  const destinations: LinkDestination[] = [
    ...(new Set(activeSteps.map((p) => p.kind)).size > 1 ? [{ label: "Next step (#next-step)", href: NEXT_STEP, group: "This slug's funnel (same URL)" }] : []),
    ...directSteps.filter((p) => p.id !== currentPageId).map((p) => ({ label: p.name, href: pageHref(p.id), group: "This slug's funnel (same URL)" })),
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
          <span className="text-xs text-muted" title="Domains get copies. Editing here doesn't change the copies that already exist.">
            · {scope === "funnel" ? "funnel" : "template"}
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

      {/* Body: rail + panel | canvas | inspector */}
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
                <SubPagesPanel
                  pages={outline.pages}
                  currentId={currentPageId}
                  mode={outline.funnelMode}
                  canEdit={fullDoc}
                  actions={subPages}
                  templates={templates}
                />
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

          {/* Bottom bar: device, mode, preview base, hidden count */}
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

        {/* Inspector */}
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
        {kind === "FUNNEL" ? (
          <span className="rounded-md bg-foreground/5 px-2 py-1.5 text-xs">{PAGE_KIND_LABELS.FUNNEL}</span>
        ) : (
          <select value={kind} onChange={(e) => onKind(e.target.value as PageKind)} className={`${SELECT_BASE} w-full`}>
            {TEMPLATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {PAGE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        )}
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
 * List of the {{key}} placeholders with a copy button. On a domain page
 * it shows the value that goes in its place; on a template, an example.
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
