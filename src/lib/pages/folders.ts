import type { Folder } from "./types";

/**
 * Árvore de pastas da tela /paginas. As pastas vêm todas do banco (são
 * poucas) e a tela monta o que precisa: filhas de uma pasta, o caminho até a
 * raiz (breadcrumb) e "X é descendente de Y" (para não mover uma pasta para
 * dentro dela mesma). Tudo tolera dado torto — um ciclo no banco não trava a
 * tela, só corta o caminho.
 */

export type FolderMap = Map<string, Folder>;

export function folderMap(folders: Folder[]): FolderMap {
  return new Map(folders.map((f) => [f.id, f]));
}

const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });

/** Pastas diretamente dentro de `parentId` (null = raiz), por nome. */
export function childFolders(folders: Folder[], parentId: string | null): Folder[] {
  return folders.filter((f) => (f.parent_id ?? null) === parentId).sort(byName);
}

/** Caminho da raiz até a pasta (inclusive). Vazio se não existir. */
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

/** `id` está dentro de `ancestorId` (em qualquer nível)? */
export function isInside(map: FolderMap, id: string | null, ancestorId: string): boolean {
  return folderPath(map, id).some((f) => f.id === ancestorId);
}

/** "Funis / F1 / F1-a" — para mostrar onde um resultado de busca está. */
export function folderPathLabel(map: FolderMap, id: string | null, root = "Páginas"): string {
  const path = folderPath(map, id);
  return path.length ? path.map((f) => f.name).join(" / ") : root;
}

export type FolderOption = { id: string | null; label: string; depth: number };

/**
 * Lista achatada para um <select> "Mover para…": raiz + todas as pastas em
 * ordem de árvore, com profundidade. `exclude` tira uma pasta e a subárvore
 * dela (a pasta que está sendo movida).
 */
export function folderOptions(folders: Folder[], exclude: string | null = null, root = "Páginas"): FolderOption[] {
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
