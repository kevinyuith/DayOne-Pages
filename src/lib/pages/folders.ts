import type { Folder } from "./types";

/**
 * Folder tree of the /templates screen. All folders come from the database
 * (there are few) and the screen builds what it needs: a folder's children, the
 * path to the root (breadcrumb) and "X is a descendant of Y" (so a folder isn't
 * moved into itself). Everything tolerates bad data — a cycle in the database
 * doesn't hang the screen, it just cuts the path.
 */

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
