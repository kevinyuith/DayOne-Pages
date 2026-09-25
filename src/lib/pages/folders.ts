import type { Folder } from "./types";

/**
 * Folder tree of the /templates screen. Folders aren't stored: each template
 * keeps its folder as a path (pages.pages.folder, "Funnels/F23/White"; null =
 * the root) and the tree comes from the paths — a folder exists while a
 * template is in it (the screen keeps a new, still empty one in the session).
 * A folder's `id` is its full path. The screen builds what it needs: a folder's
 * children, the path to the root (breadcrumb) and "X is inside Y" (so a folder
 * isn't moved into itself).
 */

/** Up to 10 levels; a segment has 1–80 characters, no "/", no spaces at the ends (pages_folder_path in the database). */
export const FOLDER_MAX_DEPTH = 10;
export const FOLDER_NAME_MAX = 80;

/** A folder name typed on the screen, or null if it can't be one ("/" inside, empty, too long). */
export function cleanFolderName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= FOLDER_NAME_MAX && !name.includes("/") ? name : null;
}

/** Is this a valid folder path? */
export function isFolderPath(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const parts = v.split("/");
  return parts.length <= FOLDER_MAX_DEPTH && parts.every((p) => cleanFolderName(p) === p);
}

/** The path of `name` inside `parent` (null = the root). */
export const joinFolder = (parent: string | null, name: string) => (parent ? `${parent}/${name}` : name);

/** The parent of a path (null = the root). */
export const parentFolder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null);

/** The last segment of a path (the folder's name). */
export const folderName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The tree behind these paths: every folder, with its ancestors, once. */
export function foldersFromPaths(paths: Iterable<string | null | undefined>): Folder[] {
  const out = new Map<string, Folder>();
  for (const path of paths) {
    if (!path || !isFolderPath(path)) continue;
    for (let cur: string | null = path; cur && !out.has(cur); cur = parentFolder(cur)) {
      out.set(cur, { id: cur, name: folderName(cur), parent_id: parentFolder(cur) });
    }
  }
  return [...out.values()];
}

/** A path with the `from` prefix replaced by `to` (the folder was renamed/moved), or unchanged. */
export function movePath(path: string, from: string, to: string): string {
  return path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

export type FolderMap = Map<string, Folder>;

export function folderMap(folders: Folder[]): FolderMap {
  return new Map(folders.map((f) => [f.id, f]));
}

const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });

/** Folders directly inside `parentId` (null = root), by name. */
export function childFolders(folders: Folder[], parentId: string | null): Folder[] {
  return folders.filter((f) => (f.parent_id ?? null) === parentId).sort(byName);
}

/** Path from the root to the folder (inclusive). Empty if it doesn't exist. */
export function folderPath(map: FolderMap, id: string | null): Folder[] {
  const out: Folder[] = [];
  const seen = new Set<string>();
  let cur = id ? map.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent_id ? map.get(cur.parent_id) : undefined;
  }
  return out;
}

/** Is `id` inside `ancestorId` (at any level)? */
export function isInside(map: FolderMap, id: string | null, ancestorId: string): boolean {
  return folderPath(map, id).some((f) => f.id === ancestorId);
}

/** "Funnels / F1 / F1-a" — to show where a search result lives. */
export function folderPathLabel(map: FolderMap, id: string | null, root = "Templates"): string {
  const path = folderPath(map, id);
  return path.length ? path.map((f) => f.name).join(" / ") : root;
}

export type FolderOption = { id: string | null; label: string; depth: number };

/**
 * Flattened list for a "Move to…" <select>: root + every folder in tree
 * order, with depth. `exclude` drops a folder and its subtree (the folder
 * being moved).
 */
export function folderOptions(folders: Folder[], exclude: string | null = null, root = "Templates"): FolderOption[] {
  const out: FolderOption[] = [{ id: null, label: root, depth: 0 }];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const f of childFolders(folders, parentId)) {
      if (f.id === exclude || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ id: f.id, label: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}
