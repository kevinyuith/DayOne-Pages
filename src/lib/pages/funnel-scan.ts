/**
 * Reads the steps and variants of an HTML document WITHOUT a DOM — for the
 * dashboard server (Funnel screen, A/B test results). It's the same reading as
 * `funnel_sections` in server/src/funnel.php: comments, <script>, <style>
 * and <template> are blanked out of a copy (same length) before counting
 * <section>/</section>; a step is the first <section data-dop-page> opened
 * outside another one, at any depth. In the editor, with a DOM, `listPages`
 * (subpages.ts) applies; the rules are the same.
 */

import { DEFAULT_WEIGHT, SUB_KIND_LABELS, versionLetter, type SubPageKind } from "./subpages";

export type ScannedVersion = {
  id: string;
  kind: SubPageKind;
  /** "Lander", or "Lander B" when the step has more than one variant. */
  name: string;
  letter: string;
  weight: number;
  /** Has code (without it the variant is inactive and never shows). */
  active: boolean;
};

function blankOpaque(html: string): string {
  return html.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m) => " ".repeat(m.length));
}

function hasCode(inner: string): boolean {
  return inner.replace(/<!--[\s\S]*?-->|&nbsp;|&#160;|&#xa0;| /gi, "").trim() !== "";
}

const attr = (attrs: string, name: string): string | null => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1] ?? null;

/** The HTML's variants, in document order (empty: a slug with no steps). */
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
