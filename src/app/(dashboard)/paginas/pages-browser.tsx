"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type DragEvent, type ReactNode } from "react";
import {
  ChevronRightIcon,
  DuplicateIcon,
  ExternalIcon,
  FileEditIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  MoreIcon,
  MoveIcon,
  PaletteIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import type { ActionResult } from "@/lib/action-result";
import { childFolders, folderMap, folderOptions, folderPath, folderPathLabel, isInside } from "@/lib/pages/folders";
import type { PageListItem } from "@/lib/pages/queries";
import { FOLDER_COLORS, FOLDER_COLOR_LABELS, PAGE_KIND_LABELS, PAGE_STATUS_LABELS, type Folder, type FolderColor } from "@/lib/pages/types";
import { createFolder, deleteFolder, deletePage, duplicatePage, moveFolder, movePage, renameFolder, renamePage, setFolderColor } from "./actions";
import { CreatePageForm } from "./create-page-form";

/**
 * A tela /paginas no modelo do hidepages: cards, pastas aninhadas, breadcrumb,
 * busca, menu "…" em cada card e arrastar-e-soltar para mover. A tela /funil
 * mostra os funis do dayone-main em lista (ver funil/page.tsx).
 *
 * A pasta aberta vem da URL (`?pasta=<id>`), então cada pasta tem link. O
 * servidor manda TODAS as pastas e páginas (são poucas centenas no máximo) e
 * a tela filtra; a busca é local e atravessa as pastas. Toda mutação é uma
 * server action, que revalida `/paginas` — a tela recebe o dado novo sem
 * manter estado próprio além do que está sendo arrastado/editado.
 */

const TEXT = {
  base: "/paginas",
  root: "Templates",
  create: "Create template",
  search: "Search templates or folders…",
  many: "templates",
  newTitle: "New template",
  emptyRoot: "No templates yet. Create the first one: it starts as a draft with the slug /.",
  emptyFolder: "This folder is empty. Create a template here or drag templates and folders into it.",
  deleteQ: (name: string) => `Delete the template "${name}" and all its slugs? The copies domains already have won't change.`,
};

const FOLDER_COLOR_CLASS: Record<FolderColor, string> = {
  blue: "text-blue-500",
  emerald: "text-emerald-500",
  violet: "text-violet-500",
  amber: "text-amber-500",
  rose: "text-rose-500",
  slate: "text-slate-400",
};
const FOLDER_COLOR_SWATCH: Record<FolderColor, string> = {
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  violet: "bg-violet-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  slate: "bg-slate-400",
};
const folderColorClass = (c: FolderColor | null) => (c ? FOLDER_COLOR_CLASS[c] : "text-accent");

type Drag = { type: "page" | "folder"; id: string };

type DialogState =
  | { kind: "create-page" }
  | { kind: "new-folder" }
  | { kind: "rename-folder"; folder: Folder }
  | { kind: "rename-page"; page: PageListItem }
  | { kind: "move"; item: Drag; name: string; from: string | null }
  | { kind: "color"; folder: Folder }
  | null;

const DRAG_MIME = "application/x-dayone-item";

export function PagesBrowser({ folders, pages, currentFolderId }: { folders: Folder[]; pages: PageListItem[]; currentFolderId: string | null }) {
  const T = TEXT;
  const ROOT_LABEL = T.root;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const map = useMemo(() => folderMap(folders), [folders]);
  const current = currentFolderId ? (map.get(currentFolderId) ?? null) : null;
  const currentId = current?.id ?? null;
  const trail = useMemo(() => folderPath(map, currentId), [map, currentId]);

  // Quantos itens (páginas + subpastas) cada pasta tem, direto nela.
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const f of folders) if (f.parent_id) c.set(f.parent_id, (c.get(f.parent_id) ?? 0) + 1);
    for (const p of pages) if (p.folder_id) c.set(p.folder_id, (c.get(p.folder_id) ?? 0) + 1);
    return c;
  }, [folders, pages]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const shownFolders = searching ? folders.filter((f) => f.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)) : childFolders(folders, currentId);
  const shownPages = searching ? pages.filter((p) => p.name.toLowerCase().includes(q)) : pages.filter((p) => (p.folder_id ?? null) === currentId);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const run = useCallback(
    <T extends object>(fn: () => Promise<ActionResult<T>>, after?: (r: { ok: true } & T) => void) => {
      setError(null);
      start(async () => {
        const r = await fn();
        if (!r.ok) setError(r.reason);
        else after?.(r);
      });
    },
    [start],
  );

  const targetLabel = useCallback((id: string | null) => (id ? (map.get(id)?.name ?? "folder") : ROOT_LABEL), [map, ROOT_LABEL]);

  /** Pode soltar `item` na pasta `target` (null = raiz)? Não na mesma pasta, nem uma pasta dentro dela mesma. */
  const canDropItem = useCallback(
    (item: Drag, target: string | null) => {
      if (item.type === "page") return (pages.find((p) => p.id === item.id)?.folder_id ?? null) !== target;
      const f = map.get(item.id);
      if (!f || f.id === target || (f.parent_id ?? null) === target) return false;
      return !(target && isInside(map, target, f.id));
    },
    [map, pages],
  );

  const moveItem = useCallback(
    (item: Drag, target: string | null) => {
      if (!canDropItem(item, target)) return;
      const done = () => setNotice(`Moved to ${targetLabel(target)}.`);
      if (item.type === "page") run(() => movePage(item.id, target), done);
      else run(() => moveFolder(item.id, target), done);
    },
    [canDropItem, run, targetLabel],
  );

  // ── Arrastar e soltar ──────────────────────────────────────────────────────
  const dragProps = (item: Drag): CardDragProps => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
      e.dataTransfer.setData("text/plain", item.id);
      e.dataTransfer.effectAllowed = "move";
      setDragging(item);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropKey(null);
    },
  });

  const dropProps = (target: string | null, key: string): CardDropProps => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging || !canDropItem(dragging, target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropKey !== key) setDropKey(key);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      if (dropKey === key) setDropKey(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      let item = dragging;
      if (!item) {
        try {
          item = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as Drag;
        } catch {
          item = null;
        }
      }
      setDragging(null);
      setDropKey(null);
      if (item) moveItem(item, target);
    },
  });

  // ── Ações dos menus ────────────────────────────────────────────────────────
  const onDeletePage = (p: PageListItem) => {
    if (!window.confirm(T.deleteQ(p.name))) return;
    run(() => deletePage(p.id), () => setNotice("Template deleted."));
  };
  const onDeleteFolder = (f: Folder) => {
    const dest = f.parent_id ? `"${map.get(f.parent_id)?.name ?? "parent folder"}"` : "the root";
    if (!window.confirm(`Delete the folder "${f.name}"? The ${T.many} and subfolders inside it will move to ${dest}.`)) return;
    run(() => deleteFolder(f.id), () => setNotice("Folder deleted."));
  };
  const onDuplicate = (p: PageListItem) => run(() => duplicatePage(p.id), () => setNotice(`"${p.name}" duplicated as a draft.`));

  const closeDialog = useCallback(() => setDialog(null), []);

  const empty = !searching && shownFolders.length === 0 && shownPages.length === 0;

  return (
    <div>
      {/* Breadcrumb + busca + nova pasta */}
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <nav aria-label="Folders" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <Crumb href={T.base} active={currentId === null} highlight={dropKey === "crumb:root"} {...dropProps(null, "crumb:root")}>
            {ROOT_LABEL}
          </Crumb>
          {trail.map((f) => (
            <span key={f.id} className="flex items-center gap-1">
              <ChevronRightIcon className="size-3.5 text-muted/60" />
              <Crumb href={`${T.base}?pasta=${f.id}`} active={f.id === currentId} highlight={dropKey === `crumb:${f.id}`} {...dropProps(f.id, `crumb:${f.id}`)}>
                {f.name}
              </Crumb>
            </span>
          ))}
        </nav>
        <div className="flex gap-2">
          <label className="relative flex-1 md:w-72">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={T.search}
              aria-label="Search"
              className={`${INPUT_CLASS} pl-8`}
            />
          </label>
          <Button variant="secondary" onClick={() => setDialog({ kind: "new-folder" })} disabled={pending}>
            <FolderPlusIcon className="size-4" /> New folder
          </Button>
        </div>
      </div>

      {error ? (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" className="mb-3">
          {notice}
        </Alert>
      ) : null}
      {searching ? (
        <p className="mb-3 text-xs text-muted">
          {shownFolders.length + shownPages.length} {shownFolders.length + shownPages.length === 1 ? "result" : "results"} for “{query.trim()}” in all folders.
        </p>
      ) : null}

      <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 ${pending ? "opacity-70" : ""}`}>
        {!searching ? (
          <button
            type="button"
            onClick={() => setDialog({ kind: "create-page" })}
            className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-accent/50 bg-accent/5 p-4 text-accent transition-colors hover:border-accent hover:bg-accent/10"
          >
            <FilePlusIcon className="size-12" strokeWidth={1.25} />
            <span className="text-sm font-semibold">{T.create}</span>
          </button>
        ) : null}

        {shownFolders.map((f) => (
          <FolderCard
            key={f.id}
            folder={f}
            count={counts.get(f.id) ?? 0}
            subtitle={searching ? folderPathLabel(map, f.parent_id, ROOT_LABEL) : null}
            dimmed={dragging?.type === "folder" && dragging.id === f.id}
            highlight={dropKey === `folder:${f.id}`}
            href={`${T.base}?pasta=${f.id}`}
            dragProps={dragProps({ type: "folder", id: f.id })}
            dropProps={dropProps(f.id, `folder:${f.id}`)}
            menu={[
              { label: "Rename", icon: <PencilIcon className="size-4" />, onClick: () => setDialog({ kind: "rename-folder", folder: f }) },
              { label: "Folder color", icon: <PaletteIcon className="size-4" />, onClick: () => setDialog({ kind: "color", folder: f }) },
              { label: "Move to…", icon: <MoveIcon className="size-4" />, onClick: () => setDialog({ kind: "move", item: { type: "folder", id: f.id }, name: f.name, from: f.parent_id }) },
              { label: "Delete", icon: <TrashIcon className="size-4" />, danger: true, onClick: () => onDeleteFolder(f) },
            ]}
          />
        ))}

        {shownPages.map((p) => (
          <PageCard
            key={p.id}
            page={p}
            href={`${T.base}/${p.id}`}
            subtitle={searching ? folderPathLabel(map, p.folder_id, ROOT_LABEL) : null}
            dimmed={dragging?.type === "page" && dragging.id === p.id}
            dragProps={dragProps({ type: "page", id: p.id })}
            menu={[
              { label: "Open", icon: <ExternalIcon className="size-4" />, href: `${T.base}/${p.id}` },
              { label: "Rename", icon: <PencilIcon className="size-4" />, onClick: () => setDialog({ kind: "rename-page", page: p }) },
              { label: "Duplicate", icon: <DuplicateIcon className="size-4" />, onClick: () => onDuplicate(p) },
              { label: "Move to…", icon: <MoveIcon className="size-4" />, onClick: () => setDialog({ kind: "move", item: { type: "page", id: p.id }, name: p.name, from: p.folder_id }) },
              { label: "Delete", icon: <TrashIcon className="size-4" />, danger: true, onClick: () => onDeletePage(p) },
            ]}
          />
        ))}
      </div>

      {empty ? (
        <p className="mt-4 text-sm text-muted">
          {current ? T.emptyFolder : T.emptyRoot}
        </p>
      ) : null}
      {searching && shownFolders.length + shownPages.length === 0 ? <p className="mt-4 text-sm text-muted">Nothing with that name.</p> : null}

      {/* ── Diálogos ─────────────────────────────────────────────────────── */}
      <Dialog
        open={dialog?.kind === "create-page"}
        title={T.newTitle}
        description={current ? `It will be created in "${current.name}".` : "It will be created in the root."}
        onClose={closeDialog}
        className="sm:max-w-2xl"
      >
        <CreatePageForm folderId={currentId} templates={pages} onCancel={closeDialog} />
      </Dialog>

      <NameDialog
        open={dialog?.kind === "new-folder"}
        title="New folder"
        description={current ? `Inside "${current.name}".` : "In the root."}
        label="Folder name"
        submitLabel="Create folder"
        maxLength={80}
        onClose={closeDialog}
        onSubmit={(name) => run(() => createFolder(currentId, name), () => setNotice(`Folder "${name}" created.`))}
      />

      <NameDialog
        open={dialog?.kind === "rename-folder"}
        title="Rename folder"
        label="Name"
        submitLabel="Rename"
        maxLength={80}
        initial={dialog?.kind === "rename-folder" ? dialog.folder.name : ""}
        onClose={closeDialog}
        onSubmit={(name) => dialog?.kind === "rename-folder" && run(() => renameFolder(dialog.folder.id, name))}
      />

      <NameDialog
        open={dialog?.kind === "rename-page"}
        title="Rename template"
        label="Name"
        submitLabel="Rename"
        minLength={2}
        maxLength={120}
        initial={dialog?.kind === "rename-page" ? dialog.page.name : ""}
        onClose={closeDialog}
        onSubmit={(name) => dialog?.kind === "rename-page" && run(() => renamePage(dialog.page.id, name))}
      />

      <MoveDialog
        open={dialog?.kind === "move"}
        state={dialog?.kind === "move" ? dialog : null}
        folders={folders}
        rootLabel={ROOT_LABEL}
        onClose={closeDialog}
        onMove={(target) => {
          if (dialog?.kind !== "move") return;
          moveItem(dialog.item, target);
        }}
      />

      <Dialog open={dialog?.kind === "color"} title="Folder color" onClose={closeDialog}>
        {dialog?.kind === "color" ? (
          <div className="flex flex-wrap gap-2">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={FOLDER_COLOR_LABELS[c]}
                aria-label={FOLDER_COLOR_LABELS[c]}
                aria-pressed={dialog.folder.color === c}
                onClick={() => {
                  const id = dialog.folder.id;
                  closeDialog();
                  run(() => setFolderColor(id, c));
                }}
                className={`size-9 rounded-full ${FOLDER_COLOR_SWATCH[c]} ${dialog.folder.color === c ? "ring-2 ring-foreground ring-offset-2 ring-offset-surface" : "hover:scale-110"} transition-transform`}
              />
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                const id = dialog.folder.id;
                closeDialog();
                run(() => setFolderColor(id, null));
              }}
            >
              Default
            </Button>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────────

type MenuItem = { label: string; icon: ReactNode; onClick?: () => void; href?: string; danger?: boolean };

type CardDragProps = { draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void };
type CardDropProps = { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };

const CARD = "group relative flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border bg-surface p-4 text-center transition-colors";

function FolderCard({
  folder,
  href,
  count,
  subtitle,
  dimmed,
  highlight,
  dragProps,
  dropProps,
  menu,
}: {
  folder: Folder;
  href: string;
  count: number;
  subtitle: string | null;
  dimmed: boolean;
  highlight: boolean;
  dragProps: CardDragProps;
  dropProps: CardDropProps;
  menu: MenuItem[];
}) {
  return (
    <div
      {...dragProps}
      {...dropProps}
      data-folder-card={folder.id}
      className={`${CARD} ${highlight ? "border-accent bg-accent/10 ring-2 ring-accent" : "border-border hover:border-accent/50"} ${dimmed ? "opacity-40" : ""}`}
    >
      <Link href={href} draggable={false} className="absolute inset-0 rounded-xl" aria-label={`Open folder ${folder.name}`} />
      <FolderIcon className={`size-16 ${folderColorClass(folder.color)}`} strokeWidth={1.25} />
      <span className="line-clamp-2 text-sm font-semibold">{folder.name}</span>
      <span className="text-[11px] text-muted">{subtitle ?? `${count} ${count === 1 ? "item" : "items"}`}</span>
      <CardMenu label={`Options for folder ${folder.name}`} items={menu} />
    </div>
  );
}

function PageCard({
  page,
  href,
  subtitle,
  dimmed,
  dragProps,
  menu,
}: {
  page: PageListItem;
  href: string;
  subtitle: string | null;
  dimmed: boolean;
  dragProps: CardDragProps;
  menu: MenuItem[];
}) {
  const draft = page.status !== "PUBLISHED";
  const Icon = draft ? FileEditIcon : FileIcon;
  return (
    <div {...dragProps} data-page-card={page.id} className={`${CARD} border-border hover:border-accent/50 ${dimmed ? "opacity-40" : ""}`}>
      <Link href={href} draggable={false} className="absolute inset-0 rounded-xl" aria-label={`Open ${page.name}`} />
      <Icon className={`size-16 ${draft ? "text-muted" : "text-foreground"}`} strokeWidth={1.25} />
      <span className="line-clamp-2 text-sm font-semibold">{page.name}</span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className={`size-1.5 rounded-full ${page.status === "PUBLISHED" ? "bg-emerald-500" : page.status === "DRAFT" ? "bg-amber-500" : "bg-muted"}`} />
        {PAGE_STATUS_LABELS[page.status]}
        <span className="text-muted/60">·</span>
        {PAGE_KIND_LABELS[page.kind]}
      </span>
      <span className="text-[11px] text-muted/70">
        {page.copies_count === 0 ? "no copies on domains" : `copied to ${page.copies_count} ${page.copies_count === 1 ? "domain" : "domains"}`}
      </span>
      {subtitle ? <span className="text-[11px] text-muted/70">{subtitle}</span> : null}
      <CardMenu label={`Options for ${page.name}`} items={menu} />
    </div>
  );
}

function Crumb({
  href,
  active,
  highlight,
  children,
  ...drop
}: { href: string; active: boolean; highlight: boolean; children: ReactNode } & CardDropProps) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      {...drop}
      className={`rounded-md px-1.5 py-0.5 transition-colors ${active ? "font-semibold text-foreground" : "text-muted hover:text-foreground"} ${highlight ? "bg-accent/15 text-accent ring-2 ring-accent" : ""}`}
    >
      {children}
    </Link>
  );
}

/** O "…" do card: abre para baixo, fecha com Escape ou clique fora. */
function CardMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="absolute right-2 top-2 z-10" onDragStart={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex size-7 items-center justify-center rounded-md text-muted transition-opacity hover:bg-foreground/10 hover:text-foreground ${open ? "bg-foreground/10 opacity-100" : "opacity-60 group-hover:opacity-100 focus:opacity-100"}`}
      >
        <MoreIcon className="size-4" />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-8 w-44 overflow-hidden rounded-lg border border-border bg-surface py-1 text-left shadow-lg">
          {items.map((it) =>
            it.href ? (
              <Link key={it.label} role="menuitem" href={it.href} className="flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-foreground/5" onClick={() => setOpen(false)}>
                {it.icon} {it.label}
              </Link>
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-foreground/5 ${it.danger ? "text-red-600 dark:text-red-400" : "text-foreground"}`}
              >
                {it.icon} {it.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Diálogos ──────────────────────────────────────────────────────────────────

function NameDialog({
  open,
  title,
  description,
  label,
  submitLabel,
  initial = "",
  minLength = 1,
  maxLength,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  submitLabel: string;
  initial?: string;
  minLength?: number;
  maxLength: number;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  return (
    <Dialog open={open} title={title} description={description} onClose={onClose}>
      <form
        key={initial}
        onSubmit={(e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
          if (name.length < minLength) return;
          onClose();
          onSubmit(name);
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">{label}</span>
          <input name="name" defaultValue={initial} required minLength={minLength} maxLength={maxLength} className={INPUT_CLASS} />
        </label>
        <div className="flex gap-2">
          <Button type="submit">{submitLabel}</Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveDialog({
  open,
  state,
  folders,
  rootLabel,
  onClose,
  onMove,
}: {
  open: boolean;
  state: Extract<DialogState, { kind: "move" }> | null;
  folders: Folder[];
  rootLabel: string;
  onClose: () => void;
  onMove: (target: string | null) => void;
}) {
  const options = useMemo(() => folderOptions(folders, state?.item.type === "folder" ? state.item.id : null, rootLabel), [folders, state, rootLabel]);
  return (
    <Dialog open={open} title={`Move "${state?.name ?? ""}"`} description="Choose the destination folder." onClose={onClose}>
      <form
        key={state?.item.id ?? "none"}
        onSubmit={(e) => {
          e.preventDefault();
          const v = String(new FormData(e.currentTarget).get("target") ?? "");
          onClose();
          onMove(v || null);
        }}
        className="flex flex-col gap-3"
      >
        <select name="target" defaultValue={state?.from ?? ""} aria-label="Destination folder" className={SELECT_CLASS}>
          {options.map((o) => (
            <option key={o.id ?? "root"} value={o.id ?? ""}>
              {"  ".repeat(o.depth)}
              {o.depth > 0 ? "└ " : ""}
              {o.label}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <Button type="submit">Move</Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

