/**
 * Page links: how the editor finds, groups and swaps a document's links —
 * and how it "attaches" a link to an element that isn't an <a>.
 *
 * Two kinds of link coexist in the saved HTML:
 *
 *  - NATIVE: `<a href>`, `<area href>`, `<form action>`. Editing swaps the
 *    attribute and that's it.
 *  - ATTACHED: any element with `data-href` (and an optional `data-target`).
 *    The page runtime (`lib/pages/runtime.ts`), saved along with the HTML,
 *    delegates the click and navigates. That way a button, image or block becomes
 *    a link WITHOUT changing the HTML's structure or CSS — and the slug stays the
 *    same; only the click destination changes. Destinations `#next-step` /
 *    `#page:<id>` switch the sub-page (see `subpages.ts`).
 *
 * Everything here operates on a `Document`: the canvas one (live, without
 * reloading the iframe) or one parsed with `parseHtml` from the saved HTML (code
 * mode). The uids are the same in both, so a list entry points to the right
 * element in the canvas.
 */

import { elementByUid, HREF_ATTR, linkHolder, PAGE_NAME_ATTR, parseHtml, serialize, shortText, TARGET_ATTR, UID_ATTR } from "./html-editing";
import { syncRuntime } from "./runtime";
import { normalizePages, pageOf } from "./subpages";

export type LinkKind = "anchor" | "form" | "attached";

export type LinkEntry = {
  uid: string;
  tag: string;
  kind: LinkKind;
  href: string;
  target: string;
  /** Short label: text, the image's alt or the tag. */
  label: string;
  external: boolean;
  /** Name of the sub-page containing the link (empty in a single-page slug). */
  page: string;
};

export type LinkGroup = { href: string; entries: LinkEntry[] };

const LINK_SELECTOR = `a[href], area[href], form[action], [${HREF_ATTR}]`;

export function isExternal(href: string): boolean {
  return /^(https?:)?\/\//i.test(href) || /^(mailto|tel|sms|whatsapp):/i.test(href);
}

/** Every link in the body, in document order. */
export function extractLinks(doc: Document): LinkEntry[] {
  const out: LinkEntry[] = [];
  doc.body?.querySelectorAll<HTMLElement>(LINK_SELECTOR).forEach((el) => {
    const uid = el.getAttribute(UID_ATTR);
    if (!uid) return;
    const kind: LinkKind = el.hasAttribute(HREF_ATTR) ? "attached" : el.tagName === "FORM" ? "form" : "anchor";
    const href = (kind === "attached" ? el.getAttribute(HREF_ATTR) : el.getAttribute(kind === "form" ? "action" : "href")) ?? "";
    const target = (kind === "attached" ? el.getAttribute(TARGET_ATTR) : el.getAttribute("target")) ?? "";
    out.push({
      uid,
      tag: el.tagName.toLowerCase(),
      kind,
      href,
      target,
      label: shortText(el) || `<${el.tagName.toLowerCase()}>`,
      external: isExternal(href),
      page: pageOf(el)?.getAttribute(PAGE_NAME_ATTR) ?? "",
    });
  });
  return out;
}

/** Groups by destination, in the order each destination first appears. */
export function groupByDestination(entries: LinkEntry[]): LinkGroup[] {
  const map = new Map<string, LinkEntry[]>();
  for (const e of entries) {
    const list = map.get(e.href);
    if (list) list.push(e);
    else map.set(e.href, [e]);
  }
  return Array.from(map, ([href, list]) => ({ href, entries: list }));
}

/**
 * Writes the link on an element that ALREADY carries one (the `holder`): <a>/<area>
 * in href, <form> in action, attached in data-href. `target` undefined = leave it.
 */
function writeLink(holder: HTMLElement, href: string, target?: string): void {
  if (holder.hasAttribute(HREF_ATTR) || !isNative(holder)) {
    if (href) holder.setAttribute(HREF_ATTR, href);
    else holder.removeAttribute(HREF_ATTR);
    if (target !== undefined || !href) {
      if (target && href) holder.setAttribute(TARGET_ATTR, target);
      else holder.removeAttribute(TARGET_ATTR);
    }
    return;
  }
  const attr = holder.tagName === "FORM" ? "action" : "href";
  if (href) holder.setAttribute(attr, href);
  else holder.removeAttribute(attr);
  if (target !== undefined) {
    if (target) holder.setAttribute("target", target);
    else holder.removeAttribute("target");
  }
}

function isNative(el: HTMLElement): boolean {
  return el.tagName === "A" || el.tagName === "AREA" || el.tagName === "FORM";
}

/**
 * Sets the link of element `uid`. If it is (or is inside) an <a>, changes
 * the <a>; otherwise attaches via data-href. An empty `href` removes the link.
 */
export function setLink(doc: Document, uid: string, link: { href: string; target?: string }): void {
  const el = elementByUid(doc, uid);
  if (!el) return;
  const holder = linkHolder(el)?.holder ?? el;
  writeLink(holder, link.href.trim(), link.target);
  syncRuntime(doc);
}

export function clearLink(doc: Document, uid: string): void {
  setLink(doc, uid, { href: "", target: "" });
}

/** Replaces ALL links whose destination is exactly `from` with `to`. Returns how many changed. */
export function replaceDestination(doc: Document, from: string, to: string): number {
  let n = 0;
  for (const e of extractLinks(doc)) {
    if (e.href !== from) continue;
    const el = elementByUid(doc, e.uid);
    if (!el) continue;
    writeLink(el, to.trim());
    n++;
  }
  syncRuntime(doc);
  return n;
}

/** Points every link on the page to `to`. Returns how many changed. */
export function replaceAll(doc: Document, to: string): number {
  let n = 0;
  for (const e of extractLinks(doc)) {
    const el = elementByUid(doc, e.uid);
    if (!el || e.href === to) continue;
    writeLink(el, to.trim());
    n++;
  }
  syncRuntime(doc);
  return n;
}

/** Applies `fn` to a Document parsed from the HTML and returns the resulting HTML (code mode). */
export function mutateHtml(html: string, fn: (doc: Document) => void): string {
  const doc = parseHtml(html);
  fn(doc);
  normalizePages(doc);
  syncRuntime(doc);
  return serialize(doc);
}
