/**
 * Leitura das etapas e amostras de um HTML SEM DOM — para o servidor do
 * painel (tela Funil, resultados do teste A/B). É a mesma leitura de
 * `funnel_sections` em server/src/funnel.php: comentários, <script>, <style>
 * e <template> são apagados de uma cópia (mesmo tamanho) antes de contar
 * <section>/</section>; uma etapa é a primeira <section data-dop-page> aberta
 * fora de outra, em qualquer profundidade. No editor, com DOM, vale
 * `listPages` (subpages.ts); as regras são as mesmas.
 */

import { DEFAULT_WEIGHT, SUB_KIND_LABELS, versionLetter, type SubPageKind } from "./subpages";

export type ScannedVersion = {
  id: string;
  kind: SubPageKind;
  /** "Lander", ou "Lander B" quando a etapa tem mais de uma amostra. */
  name: string;
  letter: string;
  weight: number;
  /** Tem código (sem ele a amostra é inativa e nunca aparece). */
  active: boolean;
};

function blankOpaque(html: string): string {
  return html.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m) => " ".repeat(m.length));
}

function hasCode(inner: string): boolean {
  return inner.replace(/<!--[\s\S]*?-->|&nbsp;|&#160;|&#xa0;| /gi, "").trim() !== "";
}

const attr = (attrs: string, name: string): string | null => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1] ?? null;

/** As amostras do HTML, na ordem do documento (vazio: slug sem etapas). */
export function scanFunnel(html: string): ScannedVersion[] {
  const scan = blankOpaque(html);
  const found: { id: string; kind: SubPageKind; weight: number; active: boolean }[] = [];
  let depth = 0;
  let open: { id: string; kind: SubPageKind; weight: number; innerFrom: number; depth: number } | null = null;
  for (const m of scan.matchAll(/<(\/?)section\b([^>]*)>/gi)) {
    const at = m.index ?? 0;
    if (m[1] !== "/") {
      const id: string | null = open ? null : attr(m[2], "data-dop-page");
      if (id) {
        const k = (attr(m[2], "data-dop-kind") ?? "").toLowerCase();
        const w = attr(m[2], "data-dop-weight");
        open = {
          id,
          kind: k === "presell" || k === "backredirect" ? k : "main",
          weight: w !== null && /^\d{1,3}$/.test(w) ? Math.min(100, Number(w)) : DEFAULT_WEIGHT,
          innerFrom: at + m[0].length,
          depth,
        };
      }
      depth++;
      continue;
    }
    depth = Math.max(0, depth - 1);
    if (open && depth === open.depth) {
      found.push({ id: open.id, kind: open.kind, weight: open.weight, active: hasCode(html.slice(open.innerFrom, at)) });
      open = null;
    }
  }
  const total: Record<SubPageKind, number> = { presell: 0, main: 0, backredirect: 0 };
  for (const v of found) total[v.kind]++;
  const seen: Record<SubPageKind, number> = { presell: 0, main: 0, backredirect: 0 };
  return found.map((v) => {
    const letter = versionLetter(seen[v.kind]++);
    return { ...v, letter, name: total[v.kind] > 1 ? `${SUB_KIND_LABELS[v.kind]} ${letter}` : SUB_KIND_LABELS[v.kind] };
  });
}
