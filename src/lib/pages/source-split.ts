import { STYLE_ID } from "@/lib/pages/html-editing";

/**
 * The editor's Code panel shows a slug's single HTML document as three
 * sources, like the reference builder's "Source code":
 *
 * - **Page CSS**: the page's own stylesheet, `<style data-dop-css>`, always the
 *   last thing in `<head>` so it wins over everything the page came with. It
 *   exists only while it has CSS.
 * - **Base CSS**: the content of every other `<style>` in the document (the CSS
 *   the page came with), in document order. With more than one block, each
 *   starts with a `Base CSS #N` header comment.
 * - **HTML**: the document without that CSS. Each base `<style>` stays where it
 *   was, emptied down to a `/* Base CSS #N *\/` marker that says which block
 *   goes back into it.
 *
 * `joinSource(splitSource(html))` gives the same HTML back. Styles inside
 * comments, `<script>`, `<template>` and `<textarea>` are not CSS of the page
 * and stay in the HTML. String scanning, not DOMParser: the HTML the person
 * sees keeps its own formatting. Works on the server and in the browser.
 */

export const PAGE_CSS_ATTR = "data-dop-css";

export type SourceParts = { html: string; pageCss: string; baseCss: string };

/**
 * One pass over the source: comments and raw-text elements that can hold a
 * `<style>` without it being one (group 1 = the whole skipped block), or a
 * `<style>` (3 = its opening as written, 4 = attributes, 5 = CSS, 6 = the
 * closing tag, 7 = the newline right after it).
 */
const TOKEN_RE =
  /(<!--[\s\S]*?(?:-->|$)|<(script|template|textarea)(?=[\s/>])[^>]*>[\s\S]*?(?:<\/\2\s*>|$))|(<style)(?=[\s/>])([^>]*)>([\s\S]*?)(<\/style\s*>)(\n?)/gi;

const PAGE_CSS_RE = new RegExp(`(^|\\s)${PAGE_CSS_ATTR}(?=[\\s=/>]|$)`, "i");
const MARKER_RE = /^\s*\/\*\s*Base CSS #(\d+)\s*\*\/\s*$/;
const HEADER_RE = /(?:^|\n)\/\* =+ Base CSS #(\d+) =+ \*\/\n?/;

const marker = (n: number) => `/* Base CSS #${n} */`;
const header = (n: number) => `/* ===== Base CSS #${n} ===== */`;

type Analysis = { html: string; pageCss: string; blocks: string[] };

/** Page CSS as written inside its tag: a newline on each side of the CSS. */
const unwrapPageCss = (css: string) => css.replace(/^\n/, "").replace(/\n$/, "");

function analyze(source: string): Analysis {
  const blocks: string[] = [];
  const page: string[] = [];
  const html = source.replace(TOKEN_RE, (match, skipped: string | undefined, _raw, open: string, attrs: string, css: string, close: string, nl: string) => {
    if (skipped !== undefined) return match;
    if (PAGE_CSS_RE.test(attrs)) {
      page.push(unwrapPageCss(css));
      return "";
    }
    blocks.push(css);
    return `${open}${attrs}>${marker(blocks.length)}${close}${nl}`;
  });
  return { html, pageCss: page.join("\n"), blocks };
}

function formatBaseCss(blocks: string[]): string {
  if (blocks.length <= 1) return blocks[0] ?? "";
  return blocks.map((css, i) => `${header(i + 1)}\n${css}`).join("\n");
}

/** Base CSS text → block number → CSS. Without headers, the whole text is block #1. */
function parseBaseCss(text: string): Map<number, string> {
  const parts = text.split(HEADER_RE);
  const blocks = new Map<number, string>();
  if (parts.length === 1) {
    blocks.set(1, text);
    return blocks;
  }
  const lead = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    const css = i === 1 && lead.trim() ? `${lead}\n${parts[i + 1]}` : parts[i + 1];
    blocks.set(n, blocks.has(n) ? `${blocks.get(n)}\n${css}` : css);
  }
  return blocks;
}

export function splitSource(source: string): SourceParts {
  const { html, pageCss, blocks } = analyze(source);
  return { html, pageCss, baseCss: formatBaseCss(blocks) };
}

export function joinSource({ html, pageCss, baseCss }: SourceParts): string {
  const blocks = parseBaseCss(baseCss);
  const used = new Set<number>();
  const typedPageCss: string[] = [];
  let out = html.replace(TOKEN_RE, (match, skipped: string | undefined, _raw, open: string, attrs: string, css: string, close: string, nl: string) => {
    if (skipped !== undefined) return match;
    // A Page CSS tag typed into the HTML joins the Page CSS (there is only one).
    if (PAGE_CSS_RE.test(attrs)) {
      typedPageCss.push(unwrapPageCss(css));
      return "";
    }
    const n = css.match(MARKER_RE)?.[1];
    // A <style> written in the HTML itself stays as it is (it becomes Base CSS next time).
    if (n === undefined) return match;
    used.add(Number(n));
    return `${open}${attrs}>${blocks.get(Number(n)) ?? ""}${close}${nl}`;
  });
  // CSS whose <style> left the HTML is not lost: it goes to the end of <head>.
  const orphans = [...blocks].filter(([n, css]) => !used.has(n) && css.trim()).map(([, css]) => css);
  if (orphans.length) out = insertBeforeHeadEnd(out, `<style>\n${orphans.join("\n")}\n</style>\n`);
  const page = [pageCss, ...typedPageCss].filter((css) => css.trim()).join("\n");
  if (page) out = insertBeforeHeadEnd(out, `<style ${PAGE_CSS_ATTR}>\n${page}\n</style>\n`);
  return out;
}

/** Blanks comments, scripts and styles so a search only finds real tags. Same length as the input. */
function maskSkipped(html: string): string {
  return html.replace(TOKEN_RE, (m) => " ".repeat(m.length));
}

function insertBeforeHeadEnd(html: string, tag: string): string {
  const masked = maskSkipped(html);
  const at = [/<\/head\s*>/i, /<body(?=[\s>])/i].map((re) => masked.search(re)).find((i) => i >= 0);
  if (at !== undefined) return html.slice(0, at) + tag + html.slice(at);
  const open = masked.match(/<html\b[^>]*>/i);
  if (open?.index !== undefined) {
    const end = open.index + open[0].length;
    return `${html.slice(0, end)}\n${tag}${html.slice(end)}`;
  }
  return tag + html;
}

/**
 * Something the browser would read wrong if applied mid-typing: a tag that is
 * not closed yet (`<div class="a`) or an attribute quote left open. Counted
 * against what is applied now, so a page that already had one (an inline
 * handler with `<`, say) never blocks. A hint for live updates only — Apply
 * always applies.
 */
export function htmlProblem(next: string, applied: string): string | null {
  const a = htmlIssues(applied);
  const b = htmlIssues(next);
  if (b.open > a.open) return "A tag is not closed.";
  if (b.quotes > a.quotes) return "An attribute quote is not closed.";
  return null;
}

function htmlIssues(html: string): { open: number; quotes: number } {
  const masked = maskSkipped(html);
  const open = masked.match(/<\/?[a-zA-Z][^<>]*(?=<|$)/g)?.length ?? 0;
  const quotes = (masked.match(/<[a-zA-Z][^<>]*>/g) ?? []).filter((tag) => /["']/.test(tag.replace(/"[^"]*"|'[^']*'/g, ""))).length;
  return { open, quotes };
}

/** A comment or string left open, or braces that don't pair up. Same use as `htmlProblem`. */
export function cssProblem(next: string, applied: string): string | null {
  const b = cssIssue(next);
  return b && b !== cssIssue(applied) ? b : null;
}

function cssIssue(css: string): string | null {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'/g, "");
  if (bare.includes("/*")) return "A comment is not closed.";
  if (/["']/.test(bare)) return "A string is not closed.";
  let depth = 0;
  for (const ch of bare) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return "There is a } without its {.";
  }
  return depth ? "A { is not closed." : null;
}

/**
 * Applies a change that touched only CSS to the canvas's live document,
 * without reloading it (no flash, the scroll stays). False when the HTML
 * changed too, or when the live document's `<style>` elements don't line up
 * with the source's blocks — then the caller reloads the canvas.
 */
export function patchStyles(doc: Document, prev: string, next: string): boolean {
  const a = analyze(prev);
  const b = analyze(next);
  if (a.html !== b.html || a.blocks.length !== b.blocks.length) return false;
  const head = doc.head;
  if (!head) return false;
  const els = Array.from(doc.querySelectorAll("style")).filter((s) => s.id !== STYLE_ID && !s.hasAttribute(PAGE_CSS_ATTR));
  if (els.length !== a.blocks.length) return false;
  b.blocks.forEach((css, i) => {
    if (css !== a.blocks[i]) els[i].textContent = css;
  });
  if (a.pageCss !== b.pageCss) {
    let el = head.querySelector<HTMLStyleElement>(`style[${PAGE_CSS_ATTR}]`);
    if (!b.pageCss.trim()) el?.remove();
    else {
      if (!el) {
        el = doc.createElement("style");
        el.setAttribute(PAGE_CSS_ATTR, "");
        // Before the editor's own style, which is dropped when saving.
        const chrome = doc.getElementById(STYLE_ID);
        if (chrome?.parentNode === head) chrome.before(el);
        else head.append(el);
      }
      el.textContent = `\n${b.pageCss}\n`;
    }
  }
  return true;
}
