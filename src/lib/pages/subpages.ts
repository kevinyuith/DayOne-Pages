/**
 * A slug's funnel — the reference builder's "without changing the slug".
 *
 * The funnel ALWAYS has the same three steps, in this order: Pre Lander → Lander
 * → Backredirect. A step with no code (no section, or an empty/comment-only
 * section) is INACTIVE and skipped. What the visitor sees first:
 * 1) the Pre Lander, if active; 2) otherwise, the Lander. The Backredirect only
 * shows up via the back button (or exit intent). A slug with no sections is just the Lander.
 *
 * A slug is still ONE HTML document (the server serves it as is). The
 * steps are sibling sections in the body:
 *
 *   <section data-dop-page="p_ab12" data-dop-name="Pre Lander" data-dop-kind="presell" data-dop-start>…</section>
 *   <section data-dop-page="p_cd34" data-dop-name="Lander" data-dop-kind="main" hidden>…</section>
 *   <section data-dop-page="p_ef56" data-dop-name="Backredirect" data-dop-kind="backredirect" data-dop-trigger="back exit" hidden>…</section>
 *   <script data-dop-runtime>…</script>
 *
 * VARIANTS (A/B test): a step can have several versions — sibling sections of
 * the same kind, each with `data-dop-weight` (0–100). They're "Lander A",
 * "Lander B"… by document order. The delivery server draws ONE per step for
 * each visitor (cookie `dop_ab`, sticky) in proportion to the weights and
 * serves only that one; without the server (preview), the first active variant
 * wins. A step is active if any of its variants has code.
 *
 * The `hidden` on the non-initial ones is the no-JS fallback. With JS, the runtime
 * shows the initial one and switches on click (`#next-step`: from the Pre Lander to
 * the Lander; `#page:<id>`), without changing the URL. The <head> (styles) is
 * shared — pages cloned from different sites can clash in CSS; prefer prefixed
 * classes. The same rules (active = has code, initial-step priority) apply
 * in `runtime.ts` and in `server/src/funnel.php`.
 *
 * Two switching modes, saved in `<body data-dop-funnel>` (see FunnelMode):
 *  - browser (default): the whole HTML goes to the visitor; switching is JS only.
 *  - server: the PHP server trims the HTML and delivers ONLY the current step, chosen
 *    by the `dop_step` cookie; the runtime sets the cookie and reloads the same URL.
 *    The pre lander's source doesn't contain the lander. It only matters on the
 *    server — canvas and preview keep showing everything.
 *
 * Everything here operates on a Document (live canvas or parsed from the HTML) and
 * returns enough for the panel: `listPages`. The mutations save nothing — the
 * caller serializes (the canvas via `commit`, code mode via `mutateHtml`).
 */

import {
  FUNNEL_MODE_ATTR,
  PAGE_ATTR,
  PAGE_CURRENT_ATTR,
  PAGE_KIND_ATTR,
  PAGE_NAME_ATTR,
  PAGE_START_ATTR,
  PAGE_TRIGGER_ATTR,
  PAGE_WEIGHT_ATTR,
  RUNTIME_ATTR,
  UID_ATTR,
} from "./html-editing";
import { NEXT_STEP, PAGE_HREF_PREFIX, RUNTIME_JS } from "./runtime";

/** The steps, in the funnel's fixed order. A kind that isn't here (old HTML) is read as "main". */
export const PAGE_KINDS_SUB = ["presell", "main", "backredirect"] as const;
export type SubPageKind = (typeof PAGE_KINDS_SUB)[number];
export const SUB_KIND_LABELS: Record<SubPageKind, string> = {
  presell: "Pre Lander",
  main: "Lander",
  backredirect: "Backredirect",
};

export type BackTrigger = "back" | "exit";

export const FUNNEL_MODES = ["browser", "server"] as const;
export type FunnelMode = (typeof FUNNEL_MODES)[number];
export const FUNNEL_MODE_LABELS: Record<FunnelMode, string> = { browser: "In the browser", server: "On the server" };

export function getFunnelMode(doc: Document): FunnelMode {
  return doc.body?.getAttribute(FUNNEL_MODE_ATTR) === "server" ? "server" : "browser";
}

/** Saves the mode on the <body>; "browser" is the default and leaves no attribute. */
export function setFunnelMode(doc: Document, mode: FunnelMode): void {
  const body = doc.body;
  if (!body) return;
  if (mode === "server") body.setAttribute(FUNNEL_MODE_ATTR, "server");
  else body.removeAttribute(FUNNEL_MODE_ATTR);
}

export type SubPage = {
  id: string;
  uid: string;
  /** "Lander", or "Lander B" when the step has more than one variant. */
  name: string;
  kind: SubPageKind;
  /** The variant's letter within the step (A, B, C…), by document order. */
  version: string;
  /** Weight in the draw (0–100). Only counts with two or more variants in the step. */
  weight: number;
  /** Has code? Without code the variant is inactive: the visitor never sees it. */
  active: boolean;
  /** The one the visitor sees first (active Pre Lander, otherwise Lander). */
  isStart: boolean;
  triggers: BackTrigger[];
};

/** Weight of a variant without `data-dop-weight` (two without a weight = 50/50). */
export const DEFAULT_WEIGHT = 50;

const SEL = `[${PAGE_ATTR}]`;

export function pageElements(doc: Document): HTMLElement[] {
  return Array.from(doc.body?.querySelectorAll<HTMLElement>(SEL) ?? []).filter((el) => !el.parentElement?.closest(SEL));
}

export function pageById(doc: Document, id: string): HTMLElement | null {
  return doc.body?.querySelector<HTMLElement>(`[${PAGE_ATTR}="${CSS.escape(id)}"]`) ?? null;
}

/** The sub-page containing `el` (or null in a slug with no sub-pages). */
export function pageOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(SEL);
}

export function hasPages(doc: Document): boolean {
  return pageElements(doc).length > 0;
}

function kindOf(el: Element): SubPageKind {
  const k = el.getAttribute(PAGE_KIND_ATTR);
  return k === "presell" || k === "backredirect" ? k : "main";
}

/** A step's variants, in document order. */
function versionsOf(doc: Document, kind: SubPageKind): HTMLElement[] {
  return pageElements(doc).filter((el) => kindOf(el) === kind);
}

/** The step has code: some element, or text that isn't just whitespace. Comments don't count. */
export function hasCode(el: Element): boolean {
  return Array.from(el.childNodes).some((n) => n.nodeType === 1 || (n.nodeType === 3 && /\S/.test(n.nodeValue ?? "")));
}

export function weightOf(el: Element): number {
  const raw = el.getAttribute(PAGE_WEIGHT_ATTR);
  if (raw === null || !/^\d{1,3}$/.test(raw.trim())) return DEFAULT_WEIGHT;
  return Math.min(100, Number(raw.trim()));
}

export const versionLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `#${i + 1}`);

export function listPages(doc: Document): SubPage[] {
  const start = startPage(doc);
  const els = pageElements(doc);
  const seen: Record<SubPageKind, number> = { presell: 0, main: 0, backredirect: 0 };
  const total: Record<SubPageKind, number> = { presell: 0, main: 0, backredirect: 0 };
  for (const el of els) total[kindOf(el)]++;
  return els.map((el) => {
    const kind = kindOf(el);
    const version = versionLetter(seen[kind]++);
    const trig = (el.getAttribute(PAGE_TRIGGER_ATTR) ?? "").split(/\s+/).filter((t): t is BackTrigger => t === "back" || t === "exit");
    return {
      id: el.getAttribute(PAGE_ATTR) ?? "",
      uid: el.getAttribute(UID_ATTR) ?? "",
      name: total[kind] > 1 ? `${SUB_KIND_LABELS[kind]} ${version}` : SUB_KIND_LABELS[kind],
      kind,
      version,
      weight: weightOf(el),
      active: hasCode(el),
      isStart: el === start,
      triggers: trig,
    };
  });
}

/**
 * The initial one, by priority: 1) the Pre Lander, if active; 2) the Lander, if
 * active (the step's first active variant). With neither active (editor only),
 * the first one that isn't the Backredirect.
 */
export function startPage(doc: Document): HTMLElement | null {
  const els = pageElements(doc);
  const active = els.filter(hasCode);
  return (
    active.find((el) => kindOf(el) === "presell") ??
    active.find((el) => kindOf(el) === "main") ??
    els.find((el) => kindOf(el) !== "backredirect") ??
    els[0] ??
    null
  );
}

export type FunnelSlot = {
  kind: SubPageKind;
  label: string;
  /** The step's variants, in order (empty: the step has no section). */
  versions: SubPage[];
  active: boolean;
  isStart: boolean;
  /** Slug with no sections: the whole document is the Lander (active, no section). */
  plain: boolean;
};

/** The three steps, always in this order, from the document's list. */
export function funnelSlots(pages: SubPage[]): FunnelSlot[] {
  return PAGE_KINDS_SUB.map((kind) => {
    const versions = pages.filter((p) => p.kind === kind);
    const plain = kind === "main" && pages.length === 0;
    return {
      kind,
      label: SUB_KIND_LABELS[kind],
      versions,
      active: plain || versions.some((v) => v.active),
      isStart: plain || versions.some((v) => v.isStart),
      plain,
    };
  });
}

/** How much of the step's traffic each ACTIVE variant gets (0–100, summing to 100). Inactive: 0. */
export function trafficShares(versions: { id: string; weight: number; active: boolean }[]): Map<string, number> {
  const live = versions.filter((v) => v.active);
  const sum = live.reduce((n, v) => n + v.weight, 0);
  const out = new Map<string, number>();
  for (const v of versions) out.set(v.id, !v.active ? 0 : sum === 0 ? 100 / live.length : (v.weight / sum) * 100);
  return out;
}

function newId(doc: Document): string {
  let id = "";
  do id = `p_${Math.random().toString(36).slice(2, 6)}`;
  while (pageById(doc, id));
  return id;
}

/**
 * Makes the document consistent: fixed kind and name per variant ("Lander",
 * "Lander B"…), a weight only on steps with more than one variant, exactly one
 * initial (by priority), `hidden` on the others (no-JS fallback) and a trigger
 * only on the Backredirect. Idempotent; runs before every serialize.
 */
export function normalizePages(doc: Document): void {
  const els = pageElements(doc);
  if (!els.length) return;
  const start = startPage(doc);
  const seen: Record<SubPageKind, number> = { presell: 0, main: 0, backredirect: 0 };
  const total: Record<SubPageKind, number> = { presell: 0, main: 0, backredirect: 0 };
  for (const el of els) total[kindOf(el)]++;
  for (const el of els) {
    const kind = kindOf(el);
    const letter = versionLetter(seen[kind]++);
    el.setAttribute(PAGE_KIND_ATTR, kind);
    el.setAttribute(PAGE_NAME_ATTR, total[kind] > 1 ? `${SUB_KIND_LABELS[kind]} ${letter}` : SUB_KIND_LABELS[kind]);
    if (total[kind] > 1) el.setAttribute(PAGE_WEIGHT_ATTR, String(weightOf(el)));
    else el.removeAttribute(PAGE_WEIGHT_ATTR);
    if (el === start) {
      el.setAttribute(PAGE_START_ATTR, "");
      el.removeAttribute("hidden");
    } else {
      el.removeAttribute(PAGE_START_ATTR);
      el.setAttribute("hidden", "");
    }
    if (kind !== "backredirect") el.removeAttribute(PAGE_TRIGGER_ATTR);
  }
}

/**
 * Turns a single-page slug into the Lander: everything in the body (except the
 * runtime) goes inside a <section>. Returns the id.
 */
export function wrapAsFirstPage(doc: Document): string {
  const body = doc.body;
  if (!body) return "";
  const existing = pageElements(doc);
  if (existing.length) return existing[0].getAttribute(PAGE_ATTR) ?? "";
  const section = doc.createElement("section");
  const id = newId(doc);
  section.setAttribute(PAGE_ATTR, id);
  section.setAttribute(PAGE_NAME_ATTR, SUB_KIND_LABELS.main);
  section.setAttribute(PAGE_KIND_ATTR, "main");
  section.setAttribute(PAGE_START_ATTR, "");
  const nodes = Array.from(body.childNodes).filter((n) => !(n instanceof Element && n.matches(`script[${RUNTIME_ATTR}]`)));
  body.prepend(section);
  section.append(...nodes);
  return id;
}

const STARTER: Record<SubPageKind, () => string> = {
  presell: () => block("Pre Lander", "This is the pre lander. Warm up the visitor and send them to the lander.", "Continue", NEXT_STEP),
  main: () => block("Lander", "This is the lander (the offer). Put the VSL or the sales letter here.", "Get the offer", "#"),
  backredirect: () => block("Backredirect", "This page shows up when the visitor hits back (or tries to leave). Hold on to them with one last offer.", "See the offer", NEXT_STEP),
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function block(title: string, text: string, cta: string, href: string): string {
  return (
    `<main style="max-width:720px;margin:0 auto;padding:64px 24px;font-family:system-ui,sans-serif">` +
    `<h1 style="font-size:2rem;line-height:1.2;margin:0 0 16px">${esc(title)}</h1>` +
    `<p style="font-size:1.05rem;line-height:1.6;margin:0 0 24px;color:#52525b">${esc(text)}</p>` +
    `<a href="${esc(href)}" style="display:inline-block;padding:14px 28px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">${esc(cta)}</a>` +
    `</main>`
  );
}

/**
 * The HTML of a new funnel (Funnel screen), WITHOUT a DOM — runs on the server: Pre
 * Lander and Lander with the starter code and the runtime already at the end of the
 * body. With `lander` (a template's HTML), its <body> becomes the Lander and its
 * <head> goes into the funnel's head.
 */
export function funnelStarterHtml(title: string, lander?: string): string {
  const pre = `p_${Math.random().toString(36).slice(2, 6)}`;
  let main = pre;
  while (main === pre) main = `p_${Math.random().toString(36).slice(2, 6)}`;
  const head = lander ? (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(lander)?.[1] ?? "").replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "").trim() : "";
  // The template's runtime is dropped: the funnel has its own, at the end of the body.
  const landerBody = lander
    ? (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(lander)?.[1] ?? lander).replace(/<script\b[^>]*\bdata-dop-runtime\b[^>]*>[\s\S]*?<\/script>/gi, "")
    : STARTER.main();
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    ...(head ? [head] : []),
    "</head>",
    "<body>",
    `<section ${PAGE_ATTR}="${pre}" ${PAGE_NAME_ATTR}="${SUB_KIND_LABELS.presell}" ${PAGE_KIND_ATTR}="presell" ${PAGE_START_ATTR}>${STARTER.presell()}</section>`,
    `<section ${PAGE_ATTR}="${main}" ${PAGE_NAME_ATTR}="${SUB_KIND_LABELS.main}" ${PAGE_KIND_ATTR}="main" hidden>${landerBody.trim()}</section>`,
    `<script ${RUNTIME_ATTR}>${RUNTIME_JS}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** A new section for step `kind`, not yet in the document. */
function newSection(doc: Document, kind: SubPageKind, html: string): HTMLElement {
  const section = doc.createElement("section");
  section.setAttribute(PAGE_ATTR, newId(doc));
  section.setAttribute(PAGE_NAME_ATTR, SUB_KIND_LABELS[kind]);
  section.setAttribute(PAGE_KIND_ATTR, kind);
  if (kind === "backredirect") section.setAttribute(PAGE_TRIGGER_ATTR, "back");
  section.innerHTML = html;
  return section;
}

/** Puts the section in its fixed-order position: after the step's last variant, or before the first step that comes after it. */
function placeSection(doc: Document, kind: SubPageKind, section: HTMLElement): void {
  const els = pageElements(doc);
  const same = els.filter((el) => kindOf(el) === kind);
  const order = PAGE_KINDS_SUB.indexOf(kind);
  const later = els.find((el) => PAGE_KINDS_SUB.indexOf(kindOf(el)) > order);
  if (same.length) same[same.length - 1].after(section);
  else if (later) later.before(section);
  else els[els.length - 1].after(section);
}

/**
 * Activates a step with starter code to edit (an empty section gets the
 * code; with no section, a new one goes in its fixed-order position). In a
 * single-page slug, the document becomes the Lander first. Returns the step's id.
 */
export function activateStep(doc: Document, kind: SubPageKind): string {
  if (!doc.body) return "";
  if (!hasPages(doc)) {
    const lander = wrapAsFirstPage(doc);
    if (kind === "main") return lander;
  }
  const mine = versionsOf(doc, kind);
  const existing = mine.find(hasCode) ?? mine[0];
  if (existing) {
    if (!hasCode(existing)) existing.innerHTML = STARTER[kind]();
    normalizePages(doc);
    return existing.getAttribute(PAGE_ATTR) ?? "";
  }
  const section = newSection(doc, kind, STARTER[kind]());
  placeSection(doc, kind, section);
  normalizePages(doc);
  return section.getAttribute(PAGE_ATTR) ?? "";
}

/**
 * New variant for the step (A/B test): a copy of another variant (`from`), the
 * given HTML (see `pageAsVersion`) or the starter code. It goes after the step's
 * last variant, and the step's traffic is split evenly again. In a single-page
 * slug, the document becomes Lander A first. Returns the id.
 */
export function addVersion(doc: Document, kind: SubPageKind, opts: { from?: string; html?: string } = {}): string {
  if (!doc.body) return "";
  if (!hasPages(doc)) wrapAsFirstPage(doc);
  const from = opts.from ? pageById(doc, opts.from) : null;
  const html = opts.html ?? (from ? from.innerHTML : STARTER[kind]());
  const section = newSection(doc, kind, html);
  if (from && kindOf(from) === "backredirect" && kind === "backredirect") {
    const trig = from.getAttribute(PAGE_TRIGGER_ATTR);
    if (trig) section.setAttribute(PAGE_TRIGGER_ATTR, trig);
  }
  placeSection(doc, kind, section);
  splitEvenly(doc, kind);
  normalizePages(doc);
  return section.getAttribute(PAGE_ATTR) ?? "";
}

/** Splits the step's traffic evenly among the variants (the rounding leftover goes to the first). */
export function splitEvenly(doc: Document, kind: SubPageKind): void {
  const mine = versionsOf(doc, kind);
  if (mine.length < 2) return;
  const each = Math.floor(100 / mine.length);
  mine.forEach((el, i) => el.setAttribute(PAGE_WEIGHT_ATTR, String(i === 0 ? 100 - each * (mine.length - 1) : each)));
}

export function setWeight(doc: Document, id: string, weight: number): void {
  const el = pageById(doc, id);
  if (!el || !Number.isFinite(weight)) return;
  el.setAttribute(PAGE_WEIGHT_ATTR, String(Math.max(0, Math.min(100, Math.round(weight)))));
}

/**
 * Removes a variant. If it's the step's only one, it's the same as deactivating
 * the step (and the last-visible-step rule applies). If only the Lander is left,
 * the slug goes back to being a single page.
 */
export function removeVersion(doc: Document, id: string): void {
  const el = pageById(doc, id);
  if (!el) return;
  const kind = kindOf(el);
  if (versionsOf(doc, kind).length < 2) return deactivateStep(doc, kind);
  // The last active variant of a step the visitor sees isn't removed if no other visible step has code.
  const otherVisible = pageElements(doc).some((p) => p !== el && kindOf(p) !== "backredirect" && hasCode(p));
  if (kind !== "backredirect" && hasCode(el) && !otherVisible) return;
  el.remove();
  unwrapIfOnlyLander(doc);
  normalizePages(doc);
}

/**
 * Deactivates a step: deletes its sections (every variant, code included).
 * The last active step the visitor can see (Pre Lander or Lander) isn't removed
 * — without it the page would be blank. If only the Lander is left, the slug
 * goes back to being a single page.
 */
export function deactivateStep(doc: Document, kind: SubPageKind): void {
  const els = pageElements(doc);
  const mine = els.filter((el) => kindOf(el) === kind);
  if (!mine.length) return;
  const flowLeft = els.some((el) => kindOf(el) !== kind && kindOf(el) !== "backredirect" && hasCode(el));
  if (kind !== "backredirect" && mine.some(hasCode) && !flowLeft) return;
  mine.forEach((el) => el.remove());
  unwrapIfOnlyLander(doc);
  normalizePages(doc);
}

/** A single section with code is left and it's the Lander: unwrap it (the empty ones go too). */
function unwrapIfOnlyLander(doc: Document): void {
  const rest = pageElements(doc);
  const active = rest.filter(hasCode);
  if (active.length === 1 && kindOf(active[0]) === "main") {
    rest.filter((el) => el !== active[0]).forEach((el) => el.remove());
    active[0].replaceWith(...Array.from(active[0].childNodes));
    doc.body?.removeAttribute(FUNNEL_MODE_ATTR);
  }
}

export function setTriggers(doc: Document, id: string, triggers: BackTrigger[]): void {
  const el = pageById(doc, id);
  if (!el) return;
  if (triggers.length) el.setAttribute(PAGE_TRIGGER_ATTR, triggers.join(" "));
  else el.removeAttribute(PAGE_TRIGGER_ATTR);
}

/**
 * A whole page's HTML (pasted, or from a template) as a variant's content:
 * the <body> and, before it, the style and script the <head> carries
 * (<style>, CSS/font <link>, <script>). That way the CSS travels with the
 * variant — and leaves with it when the server serves the other one.
 */
export function pageAsVersion(html: string): string {
  const src = new DOMParser().parseFromString(html, "text/html");
  const head = Array.from(src.head.querySelectorAll("style, link[rel~='stylesheet'], link[rel='preconnect'], link[rel='preload'], script"))
    .map((el) => el.outerHTML)
    .join("\n");
  const body = Array.from(src.body.childNodes)
    .filter((n) => !(n instanceof Element && n.matches(`script[${RUNTIME_ATTR}]`)))
    .map((n) => (n instanceof Element ? n.outerHTML : n.nodeType === 3 ? esc(n.textContent ?? "") : ""))
    .join("");
  return head ? `${head}\n${body}` : body;
}

/** Replaces a variant's content with the given HTML (see `pageAsVersion`). */
export function replaceVersionContent(doc: Document, id: string, html: string): void {
  const el = pageById(doc, id);
  if (el) el.innerHTML = html;
  normalizePages(doc);
}

/**
 * Preview only: starts at variant `id`. The other variants of the same step
 * are removed from the preview document; if it's a Lander variant, the Pre
 * Lander goes too (so the priority falls on the Lander). The Backredirect is
 * never initial: the preview starts normally and it shows up on back.
 */
export function previewFrom(doc: Document, id: string): void {
  const el = pageById(doc, id);
  if (!el) return;
  const kind = kindOf(el);
  pageElements(doc)
    .filter((p) => p !== el && (kindOf(p) === kind || (kind === "main" && kindOf(p) === "presell")))
    .forEach((p) => p.remove());
}

/** Marks (editor only) the sub-page the canvas shows. */
export function setCurrent(doc: Document, id: string | null): void {
  pageElements(doc).forEach((p) => {
    if (id && p.getAttribute(PAGE_ATTR) === id) p.setAttribute(PAGE_CURRENT_ATTR, "");
    else p.removeAttribute(PAGE_CURRENT_ATTR);
  });
}

/** The href that leads to a sub-page, for the destination picker. */
export function pageHref(id: string): string {
  return `${PAGE_HREF_PREFIX}${id}`;
}

/** If `href` points to a sub-page (`#page:<id>`), returns the id. */
export function pageIdFromHref(href: string): string | null {
  return href.startsWith(PAGE_HREF_PREFIX) ? href.slice(PAGE_HREF_PREFIX.length) : null;
}

/**
 * Replaces every sub-page id (`p_xxxx`) in an HTML with new ids — in the
 * `data-dop-page` attributes and in every `#page:<id>` pointing to them. No DOM,
 * so it runs on the server (duplicate page): two slugs with the SAME step ids
 * would share the `dop_step` cookie in server mode.
 */
export function refreshPageIds(html: string, random: () => string = () => Math.random().toString(36).slice(2, 6)): string {
  const ids = new Set<string>();
  for (const m of html.matchAll(/\bdata-dop-page\s*=\s*"(p_[a-z0-9]{1,16})"/gi)) ids.add(m[1]);
  if (ids.size === 0) return html;
  const map = new Map<string, string>();
  const taken = new Set(ids);
  for (const id of ids) {
    let next = "";
    do next = `p_${random()}`;
    while (taken.has(next));
    taken.add(next);
    map.set(id, next);
  }
  // Only where an id appears as an id: the data-dop-page attribute, cookie/href #page:<id>.
  return html
    .replace(/(\bdata-dop-page\s*=\s*")(p_[a-z0-9]{1,16})(")/gi, (_, a: string, id: string, z: string) => a + (map.get(id) ?? id) + z)
    .replace(/(#page:)(p_[a-z0-9]{1,16})\b/g, (_, a: string, id: string) => a + (map.get(id) ?? id));
}
