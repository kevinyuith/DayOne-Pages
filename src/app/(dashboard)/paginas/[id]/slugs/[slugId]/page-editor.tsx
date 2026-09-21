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
  addPage,
  duplicatePage,
  getFunnelMode,
  listPages,
  movePage,
  pageById,
  pageHref,
  removePage,
  renamePage,
  setFunnelMode,
  setPageKind,
  setStart,
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
import { createSlug, deletePage, deleteSlug, renameSlug, saveEditor, toggleSlug } from "../../../actions";

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
}: {
  page: Page;
  slugs: PageSlugSummary[];
  slug: PageSlug;
  domains: string[];
}) {
  const router = useRouter();

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
        const result = await saveEditor({
          page: { id: page.id, name, kind, status: nStatus, expectedUpdatedAt: pageUpdatedAt },
          slug: content !== savedSnapshot.content ? { id: slug.id, content, expectedUpdatedAt: slugUpdatedAt } : null,
        });
        if (!result.ok) {
          setMessage(
            result.reason === "conflict"
              ? { tone: "warning", text: "Esta página foi salva em outro lugar desde que você a abriu. Recarregue para ver a versão atual (o que está nesta tela será descartado)." }
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
    [pending, page.id, name, kind, status, pageUpdatedAt, content, savedSnapshot.content, slug.id, slugUpdatedAt, router],
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
      if (!window.confirm("Há alterações não salvas. Sair mesmo assim?")) {
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
        setMessage({ tone: "danger", text: r.reason ?? "Erro." });
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
      const r = await createSlug(page.id, value, null);
      if (!r.ok) return setMessage({ tone: "danger", text: r.reason });
      form.reset();
      setMessage(null);
      router.push(`/paginas/${page.id}/slugs/${r.slugId}`);
    });
  }
  function onRenameSlug() {
    const value = window.prompt("Novo path da slug:", slug.slug);
    if (value === null || value.trim() === slug.slug) return;
    run(() => renameSlug(slug.id, value));
  }
  function onDeleteSlug() {
    if (!window.confirm(`Remover a slug ${slug.slug}? O HTML dela será perdido.`)) return;
    startBusy(async () => {
      const r = await deleteSlug(slug.id);
      if (!r.ok) return setMessage({ tone: "danger", text: r.reason });
      const next = slugs.find((s) => s.id !== slug.id);
      router.push(next ? `/paginas/${page.id}/slugs/${next.id}` : "/paginas");
    });
  }
  function onDeletePage() {
    if (!window.confirm(`Excluir a página "${page.name}" e todas as slugs? Domínios que a usam como padrão ficarão sem página.`)) return;
    startBusy(async () => {
      const r = await deletePage(page.id);
      if (!r.ok) return setMessage({ tone: "danger", text: r.reason });
      dirtyRef.current = false;
      router.push("/paginas");
    });
  }

  const enterPreview = (on: boolean) => {
    if (on) {
      canvasRef.current?.clearSelection();
      setSelection(null);
      // O preview começa na sub-página que está na canvas (só no preview; nada é gravado).
      const c = contentRef.current;
      setPreviewDoc(currentPageId && isFullDocument(c) ? mutateHtml(c, (d) => setStart(d, currentPageId)) : c);
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

  // ── Funil (sub-páginas) ────────────────────────────────────────────────────
  // Toda ação muda a estrutura do body → reindexa uids. Quem escolhe a
  // sub-página mostrada é `currentPageId`; a canvas cai na inicial se ela sumir.
  const subPages: SubPagesActions = {
    select: (id) => {
      setCurrentPageId(id);
      canvasRef.current?.clearSelection();
      setSelection(null);
    },
    add: (kind, name) => {
      let created = "";
      applyDocChange((d) => void (created = addPage(d, { kind, name, after: currentPageId ?? undefined })), { reindex: true });
      if (created) setCurrentPageId(created);
    },
    rename: (id, name) => applyDocChange((d) => renamePage(d, id, name)),
    setStart: (id) => applyDocChange((d) => setStart(d, id)),
    setKind: (id, kind) => applyDocChange((d) => setPageKind(d, id, kind)),
    setTriggers: (id, t) => applyDocChange((d) => setTriggers(d, id, t)),
    move: (id, dir) => applyDocChange((d) => movePage(d, id, dir), { reindex: true }),
    duplicate: (id) => {
      let created = "";
      applyDocChange((d) => void (created = duplicatePage(d, id)), { reindex: true });
      if (created) setCurrentPageId(created);
    },
    remove: (id) => applyDocChange((d) => removePage(d, id), { reindex: true }),
    setMode: (m) => applyDocChange((d) => setFunnelMode(d, m)),
  };

  const destinations: LinkDestination[] = [
    ...(outline.pages.length > 1 ? [{ label: "Próxima sub-página (#next-step)", href: NEXT_STEP, group: "Funil desta slug (mesma URL)" }] : []),
    ...outline.pages.filter((p) => p.id !== currentPageId).map((p) => ({ label: `${p.name} (${p.kind === "backredirect" ? "back redirect" : "sub-página"})`, href: pageHref(p.id), group: "Funil desta slug (mesma URL)" })),
    ...slugs.filter((s) => s.id !== slug.id && s.is_active).map((s) => ({ label: s.slug, href: s.slug, group: "Slugs desta página (muda a URL)" })),
  ];

  const baseHref = previewBase ? `https://${previewBase}/` : undefined;
  const savedLabel = pending ? "Saving…" : dirty ? "Unsaved" : lastSavedAt ? `Saved ${lastSavedAt.toLocaleTimeString("pt-BR")}` : "Saved";

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col gap-2">
      {/* Topbar */}
      <header className="flex flex-wrap items-center gap-2">
        {/* Volta para a pasta onde a página está, não para a raiz. */}
        <Link href={page.folder_id ? `/paginas?pasta=${page.folder_id}` : "/paginas"} title="Voltar para as páginas" className="text-sm text-muted hover:text-foreground">
          ←
        </Link>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome da página" className={`${INPUT_BASE} h-9 w-52 font-medium`} />
        <Badge tone={PAGE_STATUS_TONE[savedSnapshot.status]}>{PAGE_STATUS_LABELS[savedSnapshot.status]}</Badge>
        <span className="text-xs text-muted">· {savedLabel}</span>

        <div className="ml-auto flex items-center gap-1.5">
          <IconButton title="Undo (⌘Z)" onClick={undo} disabled={!canUndo}>
            <UndoIcon className="size-4" />
          </IconButton>
          <IconButton title="Redo (⌘⇧Z)" onClick={redo} disabled={!canRedo}>
            <RedoIcon className="size-4" />
          </IconButton>
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
              Recarregar
            </button>
          ) : null}
        </Alert>
      ) : null}

      {/* Corpo: rail + painel | canvas | inspetor */}
      <div className="flex min-h-0 flex-1 gap-2">
        <div className="hidden shrink-0 gap-2 md:flex">
          <Rail active={panel} onSelect={togglePanel} badges={{ links: outline.links.length, funnel: outline.pages.length > 1 ? outline.pages.length : 0 }} />
          {panel ? (
            <aside className="flex w-64 shrink-0 flex-col rounded-xl border border-border bg-surface">
              {panel === "pages" ? (
                <PagesPanel
                  pageId={page.id}
                  slugs={slugs}
                  currentSlugId={slug.id}
                  currentActive={slug.is_active}
                  busy={busy}
                  onNewSlug={onNewSlug}
                  onRename={onRenameSlug}
                  onToggle={() => run(() => toggleSlug(slug.id, !slug.is_active))}
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
                <HtmlPreview html={previewDoc || content} baseHref={baseHref} className="h-full w-full" />
              ) : mode === "code" ? (
                <div className="h-full bg-surface">
                  <CodeEditor value={content} onChange={updateContent} />
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
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <p className="text-sm font-medium">A edição visual precisa de um documento HTML completo.</p>
                  <p className="max-w-sm text-xs text-muted">Este conteúdo é um fragmento. Embrulhe num documento para editar no canvas, ou use o modo Código.</p>
                  <Button size="sm" onClick={() => updateContent(wrapFragment(content, { title: name }))}>
                    Envolver fragmento em documento
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
              <Seg active={device === "mobile"} title="Celular" onClick={() => setDevice("mobile")}>
                <MobileIcon className="size-4" />
              </Seg>
            </div>

            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              <Seg active={mode === "visual" && !previewing} title="Visual" onClick={() => switchMode("visual")}>
                <EyeIcon className="size-4" />
              </Seg>
              <Seg active={mode === "code" && !previewing} title="Código" onClick={() => switchMode("code")}>
                <CodeIcon className="size-4" />
              </Seg>
            </div>

            <select value={previewBase} onChange={(e) => setPreviewBase(e.target.value)} aria-label="Domínio base" className={`${SELECT_BASE} h-8 w-40 text-xs`}>
              <option value="">Sem domínio base</option>
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
                title={showMarkers ? "Ocultar marcadores de link" : "Mostrar marcadores de link"}
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
      <p className="text-xs text-muted">Nada selecionado. Clique num elemento do canvas para editá-lo, ou ajuste a página:</p>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Slug</span>
        <code className="rounded-md bg-foreground/5 px-2 py-1.5 font-mono text-xs">{slugPath}</code>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Tipo</span>
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
        <p className="text-xs text-amber-700 dark:text-amber-400">Só páginas Publicadas são servidas nos domínios.</p>
      ) : null}
      <Button size="sm" variant="danger" onClick={onDeletePage} disabled={busy} className="mt-2 w-full">
        Excluir página
      </Button>
    </div>
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
