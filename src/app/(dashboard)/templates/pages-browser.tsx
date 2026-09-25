"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import type { ActionResult } from "@/lib/action-result";
import {
  FOLDER_MAX_DEPTH,
  FOLDER_NAME_MAX,
  childFolders,
  cleanFolderName,
  folderMap,
  folderOptions,
  folderPath,
  folderPathLabel,
  foldersFromPaths,
  isFolderPath,
  isInside,
  joinFolder,
  movePath,
  parentFolder,
} from "@/lib/pages/folders";
import type { PageListItem } from "@/lib/pages/queries";
import { PAGE_KIND_LABELS, PAGE_STATUS_LABELS, type Folder } from "@/lib/pages/types";
import { deleteFolder, deletePage, duplicatePage, moveFolder, movePage, renameFolder, renamePage } from "./actions";
import { CreatePageForm } from "./create-page-form";

/**
 * The /templates screen modeled on hidepages: cards, nested folders, breadcrumb,
 * search, a "…" menu on each card and drag-and-drop to move. The /funnels screen
 * shows the dayone-main funnels as a list (see funnels/page.tsx).
 *
 * The open folder comes from the URL (`?folder=<path>`), so every folder has a link.
 * The server sends ALL pages (a few hundred at most) and the folders their paths
 * make; the screen filters, and search is local and spans all folders. Every
 * mutation is a server action that revalidates `/templates`.
 *
 * A folder is the path its templates keep (pages.pages.folder): a NEW folder
 * has no template yet, so the screen keeps it (for the browser session, across
 * folders) until a template goes into it. Renaming/moving/deleting a folder
 * with templates goes to the database; one that is still empty only changes here.
 */

const TEXT = {
  base: "/templates",
  root: "Templates",
  create: "Create template",
  search: "Search templates or folders…",
  many: "templates",
  newTitle: "New template",
  emptyRoot: "No templates yet. Create the first one: it starts as a draft with the slug /.",
  emptyFolder: "This folder is empty. Create a template here or drag templates and folders into it.",
  deleteQ: (name: string) => `Delete the template "${name}" and all its slugs? The copies domains already have won't change.`,
};

/** New folders (no template yet) of this browser session: they survive moving between folders, not a reload. */
const sessionFolders = { paths: [] as string[] };

type Drag = { type: "page" | "folder"; id: string };

type DialogState =
  | { kind: "create-page" }
  | { kind: "new-folder" }
  | { kind: "rename-folder"; folder: Folder }
  | { kind: "rename-page"; page: PageListItem }
  | { kind: "move"; item: Drag; name: string; from: string | null }
  | null;

const DRAG_MIME = "application/x-dayone-item";

export function PagesBrowser({ folders: saved, pages, currentFolderId }: { folders: Folder[]; pages: PageListItem[]; currentFolderId: string | null }) {
  const T = TEXT;
  const router = useRouter();
  const ROOT_LABEL = T.root;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [newFolders, setNewFoldersState] = useState<string[]>(() => sessionFolders.paths);
  const setNewFolders = useCallback((next: string[]) => {
    sessionFolders.paths = next;
    setNewFoldersState(next);
  }, []);

  // The saved folders (from the templates' paths) + the new ones + the open one (a new folder opened by link).
  const folders = useMemo(
    () => foldersFromPaths([...saved.map((f) => f.id), ...newFolders, ...(currentFolderId ? [currentFolderId] : [])]),
    [saved, newFolders, currentFolderId],
  );
  /** Does the folder hold a template somewhere below (saved), or is it only on this screen (new)? */
  const isSaved = useCallback((path: string) => saved.some((f) => f.id === path), [saved]);
  /** The new folders after `from` became `to` (renamed/moved) — or went up a level (deleted: `to` = null). */
  const followFolder = useCallback(
    (from: string, to: string | null) =>
      setNewFolders(
        newFolders.flatMap((p) => {
          if (to !== null) return [movePath(p, from, to)];
          if (p === from) return [];
          const up = parentFolder(from);
          return [p.startsWith(`${from}/`) ? joinFolder(up, p.slice(from.length + 1)) : p];
        }),
      ),
    [newFolders, setNewFolders],
  );
  /** The open folder was renamed/moved/deleted: the URL follows it. */
  const followCurrent = useCallback(
    (from: string, to: string | null) => {
      if (!currentFolderId || (currentFolderId !== from && !currentFolderId.startsWith(`${from}/`))) return;
      const next = to !== null ? movePath(currentFolderId, from, to) : parentFolder(from);
      router.replace(next ? `${TEXT.base}?folder=${encodeURIComponent(next)}` : TEXT.base);
    },
    [currentFolderId, router],
  );

  const map = useMemo(() => folderMap(folders), [folders]);
  const current = currentFolderId ? (map.get(currentFolderId) ?? null) : null;
  const currentId = current?.id ?? null;
  const trail = useMemo(() => folderPath(map, currentId), [map, currentId]);

  // How many items (pages + subfolders) each folder holds directly.
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const f of folders) if (f.parent_id) c.set(f.parent_id, (c.get(f.parent_id) ?? 0) + 1);
    for (const p of pages) if (p.folder) c.set(p.folder, (c.get(p.folder) ?? 0) + 1);
    return c;
  }, [folders, pages]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const shownFolders = searching ? folders.filter((f) => f.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)) : childFolders(folders, currentId);
  const shownPages = searching ? pages.filter((p) => p.name.toLowerCase().includes(q)) : pages.filter((p) => (p.folder ?? null) === currentId);

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

  /** Can `item` be dropped into folder `target` (null = root)? Not into the same folder, nor a folder into itself. */
  const canDropItem = useCallback(
    (item: Drag, target: string | null) => {
      if (item.type === "page") return (pages.find((p) => p.id === item.id)?.folder ?? null) !== target;
      const f = map.get(item.id);
      if (!f || f.id === target || (f.parent_id ?? null) === target) return false;
      return !(target && isInside(map, target, f.id)) && isFolderPath(joinFolder(target, f.name));
    },
    [map, pages],
  );

  const moveItem = useCallback(
    (item: Drag, target: string | null) => {
      if (!canDropItem(item, target)) return;
      const done = () => setNotice(`Moved to ${targetLabel(target)}.`);
      if (item.type === "page") {
        run(() => movePage(item.id, target), done);
        return;
      }
      const to = joinFolder(target, map.get(item.id)?.name ?? "");
      if (!isSaved(item.id)) {
        // Still empty: only this screen knows it.
        followFolder(item.id, to);
        followCurrent(item.id, to);
        done();
        return;
      }
      run(
        () => moveFolder(item.id, target),
        (r) => {
          followFolder(item.id, r.path);
          followCurrent(item.id, r.path);
          done();
        },
      );
    },
    [canDropItem, run, targetLabel, map, isSaved, followFolder, followCurrent],
  );

  // ── Drag and drop ──────────────────────────────────────────────────────────
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

  // ── Menu actions ───────────────────────────────────────────────────────────
  const onDeletePage = (p: PageListItem) => {
    if (!window.confirm(T.deleteQ(p.name))) return;
    run(() => deletePage(p.id), () => setNotice("Template deleted."));
  };
  const onDeleteFolder = (f: Folder) => {
    const dest = f.parent_id ? `"${map.get(f.parent_id)?.name ?? "parent folder"}"` : "the root";
    if (!window.confirm(`Delete the folder "${f.name}"? The ${T.many} and subfolders inside it will move to ${dest}.`)) return;
    const after = () => {
      followFolder(f.id, null);
      followCurrent(f.id, null);
      setNotice("Folder deleted.");
    };
    if (isSaved(f.id)) run(() => deleteFolder(f.id), after);
    else after();
  };
  const onNewFolder = (raw: string) => {
    const name = cleanFolderName(raw);
    const path = name ? joinFolder(currentId, name) : null;
    if (!name || !path) return setError(`Enter a name of 1 to ${FOLDER_NAME_MAX} characters, without "/".`);
    if (!isFolderPath(path)) return setError(`Folders go up to ${FOLDER_MAX_DEPTH} levels.`);
    if (map.has(path)) return setError(`There's already a folder "${name}" here.`);
    setError(null);
    setNewFolders([...newFolders, path]);
    setNotice(`Folder "${name}" created. It's kept once a template goes into it.`);
  };
  const onRenameFolder = (f: Folder, raw: string) => {
    const name = cleanFolderName(raw);
    if (!name) return setError(`Enter a name of 1 to ${FOLDER_NAME_MAX} characters, without "/".`);
    const to = joinFolder(f.parent_id, name);
    if (to === f.id) return;
    if (map.has(to)) return setError(`There's already a folder "${name}" here.`);
    if (!isSaved(f.id)) {
      followFolder(f.id, to);
      followCurrent(f.id, to);
      return;
    }
    run(
      () => renameFolder(f.id, name),
      (r) => {
        followFolder(f.id, r.path);
        followCurrent(f.id, r.path);
      },
    );
  };
  const onDuplicate = (p: PageListItem) => run(() => duplicatePage(p.id), () => setNotice(`"${p.name}" duplicated as a draft.`));

  const closeDialog = useCallback(() => setDialog(null), []);

  const empty = !searching && shownFolders.length === 0 && shownPages.length === 0;

  return (
    <div>
      {/* Breadcrumb + search + new folder */}
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <nav aria-label="Folders" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <Crumb href={T.base} active={currentId === null} highlight={dropKey === "crumb:root"} {...dropProps(null, "crumb:root")}>
            {ROOT_LABEL}
          </Crumb>
          {trail.map((f) => (
            <span key={f.id} className="flex items-center gap-1">
              <ChevronRightIcon className="size-3.5 text-muted/60" />
              <Crumb href={`${T.base}?folder=${encodeURIComponent(f.id)}`} active={f.id === currentId} highlight={dropKey === `crumb:${f.id}`} {...dropProps(f.id, `crumb:${f.id}`)}>
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
            href={`${T.base}?folder=${encodeURIComponent(f.id)}`}
            dragProps={dragProps({ type: "folder", id: f.id })}
            dropProps={dropProps(f.id, `folder:${f.id}`)}
            menu={[
              { label: "Rename", icon: <PencilIcon className="size-4" />, onClick: () => setDialog({ kind: "rename-folder", folder: f }) },
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
            subtitle={searching ? folderPathLabel(map, p.folder, ROOT_LABEL) : null}
            dimmed={dragging?.type === "page" && dragging.id === p.id}
            dragProps={dragProps({ type: "page", id: p.id })}
            menu={[
              { label: "Open", icon: <ExternalIcon className="size-4" />, href: `${T.base}/${p.id}` },
              { label: "Rename", icon: <PencilIcon className="size-4" />, onClick: () => setDialog({ kind: "rename-page", page: p }) },
              { label: "Duplicate", icon: <DuplicateIcon className="size-4" />, onClick: () => onDuplicate(p) },
              { label: "Move to…", icon: <MoveIcon className="size-4" />, onClick: () => setDialog({ kind: "move", item: { type: "page", id: p.id }, name: p.name, from: p.folder }) },
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

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
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
        maxLength={FOLDER_NAME_MAX}
        onClose={closeDialog}
        onSubmit={onNewFolder}
      />

      <NameDialog
        open={dialog?.kind === "rename-folder"}
        title="Rename folder"
        label="Name"
        submitLabel="Rename"
        maxLength={FOLDER_NAME_MAX}
        initial={dialog?.kind === "rename-folder" ? dialog.folder.name : ""}
        onClose={closeDialog}
        onSubmit={(name) => dialog?.kind === "rename-folder" && onRenameFolder(dialog.folder, name)}
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
      <FolderIcon className="size-16 text-accent" strokeWidth={1.25} />
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

/** The card's "…": opens downward, closes with Escape or a click outside. */
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

// ── Dialogs ───────────────────────────────────────────────────────────────────

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

