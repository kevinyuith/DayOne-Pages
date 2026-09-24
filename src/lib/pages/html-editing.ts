/**
 * Visual editing utilities: how the canvas marks, describes and serializes the
 * user's document.
 *
 * The canvas is a SAME-ORIGIN iframe but with `sandbox="allow-same-origin"`
 * (no `allow-scripts`): the parent sees and changes the DOM, and the user's
 * page scripts do NOT run while editing. On selection, every body element
 * gets a temporary `data-dop-uid`; on save, `serialize` clones the document
 * and removes EVERY editor artifact (uids, injected base/style, contentEditable),
 * returning the HTML exactly as the server will deliver it.
 *
 * The uids are sequential in document order. That's why a document parsed
 * with `parseHtml` (DOMParser) from the SAME HTML gets the SAME uids as
 * the canvas — which is what lets the panels (Links, Layers) point to a
 * canvas element without touching the iframe.
 */

export const UID_ATTR = "data-dop-uid";
export const STYLE_ID = "dop-editor-style";
const BASE_MARK = "data-dop-base";

/**
 * "Attached" link: an element that isn't an <a> but navigates on click. It stays
 * in the saved HTML (it's not an editor artifact) along with a small <script>
 * that delegates the click — see `lib/pages/links.ts`.
 */
export const HREF_ATTR = "data-href";
export const TARGET_ATTR = "data-target";

/**
 * Sub-pages: body sections marked with `data-dop-page="<id>"`. A slug with
 * several of them shows the initial one and switches to the others in the
 * browser, without changing the URL — see `lib/pages/subpages.ts` and `lib/pages/runtime.ts`.
 */
export const PAGE_ATTR = "data-dop-page";
export const PAGE_NAME_ATTR = "data-dop-name";
export const PAGE_KIND_ATTR = "data-dop-kind";
export const PAGE_START_ATTR = "data-dop-start";
export const PAGE_TRIGGER_ATTR = "data-dop-trigger";
/**
 * Weight (0–100) of a variant in the A/B test: with two or more sections of the
 * same kind, the server draws one per visitor in proportion to the weights.
 */
export const PAGE_WEIGHT_ATTR = "data-dop-weight";
/** Marks (editor ONLY) which sub-page the canvas is showing. Removed by serialize. */
export const PAGE_CURRENT_ATTR = "data-dop-current";
/**
 * On the <body>: how the funnel switches steps. Absent/"browser" = everything is
 * in the HTML and the runtime switches in the browser; "server" = the PHP server
 * delivers only the current step (cookie `dop_step`) and the runtime sets the
 * cookie and reloads.
 */
export const FUNNEL_MODE_ATTR = "data-dop-funnel";
/** Cookie that holds the current step in server mode. Same as FUNNEL_COOKIE in server/src/funnel.php. */
export const FUNNEL_COOKIE = "dop_step";

/** The script that makes `data-href` navigate and sub-pages switch. Stays in the saved HTML. */
export const RUNTIME_ATTR = "data-dop-runtime";

/** Elements that make no sense to select/edit as a block. */
const SKIP = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "META", "LINK", "TITLE", "BASE", "TEMPLATE", "NOSCRIPT"]);

/** No element children and non-empty: the text can be edited directly. */
const VOID = new Set(["IMG", "INPUT", "BR", "HR", "IFRAME", "VIDEO", "AUDIO", "SOURCE", "EMBED", "SVG", "CANVAS"]);

export type SelectionStyle = {
  color: string;
  background: string;
  fontSize: string;
  textAlign: string;
  padding: string;
};

/**
 * Where the selected element's link comes from:
 * - `anchor`: it is itself an <a>/<area> (or a <form>, via `action`);
 * - `inherited`: it's INSIDE an <a> — editing changes the parent <a>;
 * - `attached`: it has `data-href` (link attached by the editor);
 * - `none`: no link — one can be attached.
 */
export type LinkSource = "anchor" | "inherited" | "attached" | "none";

export type SelectionInfo = {
  uid: string;
  tag: string;
  isLink: boolean;
  href: string;
  linkSource: LinkSource;
  linkTarget: string;
  text: string;
  /** The element only has text (it can be edited in a field). */
  textEditable: boolean;
  hidden: boolean;
  style: SelectionStyle;
};

/** A node of the layer tree (Layers panel). */
export type LayerNode = {
  uid: string;
  tag: string;
  /** `#id`, `.class` or a snippet of the text — whichever identifies it best. */
  label: string;
  hidden: boolean;
  isLink: boolean;
  children: LayerNode[];
};

export function isSkipped(el: Element): boolean {
  return SKIP.has(el.tagName);
}

/** Tags the body's elements with a sequential uid (idempotent, since it reindexes). */
export function assignUids(doc: Document): void {
  const body = doc.body;
  if (!body) return;
  let n = 0;
  body.querySelectorAll<HTMLElement>("*").forEach((el) => {
    if (SKIP.has(el.tagName)) return;
    el.setAttribute(UID_ATTR, `u${n++}`);
  });
}

export function elementByUid(doc: Document, uid: string): HTMLElement | null {
  return doc.body?.querySelector<HTMLElement>(`[${UID_ATTR}="${CSS.escape(uid)}"]`) ?? null;
}

/**
 * Parses HTML into an inert Document (scripts don't run) with uids already set —
 * the same ones the canvas assigns to the same HTML. Client-only (DOMParser).
 */
export function parseHtml(html: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  assignUids(doc);
  return doc;
}

/** Injects `<base>` (for relative paths) and the editor style into the <head>. */
export function injectCanvasChrome(doc: Document, baseHref?: string): void {
  const head = doc.head ?? doc.documentElement.appendChild(doc.createElement("head"));
  if (baseHref && !head.querySelector(`base[${BASE_MARK}]`)) {
    const base = doc.createElement("base");
    base.setAttribute("href", baseHref);
    base.setAttribute(BASE_MARK, "");
    head.prepend(base);
  }
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    // No real interactions here: the selection is drawn by the parent, over the
    // iframe. We only set the cursor and neutralize anchors while editing.
    style.textContent = [
      `*{cursor:default}`,
      `[${UID_ATTR}]:hover{outline:1px dashed rgba(59,130,246,.5);outline-offset:1px}`,
      `[contenteditable="true"]{outline:2px solid #3b82f6;outline-offset:2px}`,
      `[${HREF_ATTR}]{cursor:pointer}`,
      // Sub-pages: the canvas shows only the current one (the saved `hidden` is ignored here).
      `[${PAGE_ATTR}]:not([${PAGE_CURRENT_ATTR}]){display:none!important}`,
      `[${PAGE_ATTR}][${PAGE_CURRENT_ATTR}]{display:block!important}`,
    ].join("");
    head.appendChild(style);
  }
}

const px = (v: string) => (v && v !== "0px" ? v : "");

/** The element carrying `el`'s link: itself, the <a> wrapping it, or nothing. */
export function linkHolder(el: HTMLElement): { holder: HTMLElement; source: LinkSource } | null {
  if (el.hasAttribute(HREF_ATTR)) return { holder: el, source: "attached" };
  if (el.tagName === "A" || el.tagName === "AREA" || el.tagName === "FORM") return { holder: el, source: "anchor" };
  const a = el.closest<HTMLElement>("a");
  if (a) return { holder: a, source: "inherited" };
  return null;
}

export function readLink(el: HTMLElement): { href: string; target: string; source: LinkSource } {
  const found = linkHolder(el);
  if (!found) return { href: "", target: "", source: "none" };
  const { holder, source } = found;
  if (source === "attached") return { href: holder.getAttribute(HREF_ATTR) ?? "", target: holder.getAttribute(TARGET_ATTR) ?? "", source };
  const attr = holder.tagName === "FORM" ? "action" : "href";
  return { href: holder.getAttribute(attr) ?? "", target: holder.getAttribute("target") ?? "", source };
}

export function describe(el: HTMLElement): SelectionInfo {
  const win = el.ownerDocument.defaultView;
  const cs = win ? win.getComputedStyle(el) : null;
  const link = readLink(el);
  const textEditable = el.childElementCount === 0 && !VOID.has(el.tagName);
  return {
    uid: el.getAttribute(UID_ATTR) ?? "",
    tag: el.tagName.toLowerCase(),
    isLink: link.source !== "none",
    href: link.href,
    linkSource: link.source,
    linkTarget: link.target,
    text: textEditable ? el.textContent ?? "" : "",
    textEditable,
    hidden: el.style.display === "none" || el.hasAttribute("hidden"),
    style: {
      color: el.style.color || (cs ? rgbToHex(cs.color) : ""),
      background: el.style.backgroundColor || (cs ? rgbToHex(cs.backgroundColor) : ""),
      fontSize: el.style.fontSize || px(cs?.fontSize ?? ""),
      textAlign: el.style.textAlign || (cs?.textAlign ?? ""),
      padding: el.style.padding || px(cs?.padding ?? ""),
    },
  };
}

/** Counts the elements hidden by the editor (for the "N hidden" indicator). */
export function countHidden(doc: Document): number {
  // Non-initial sub-pages are `hidden` by design — they don't count.
  return doc.body?.querySelectorAll(`[style*="display: none"]:not([${PAGE_ATTR}]), [style*="display:none"]:not([${PAGE_ATTR}]), [hidden]:not([${PAGE_ATTR}])`).length ?? 0;
}

/** Short text of an element, for panel labels. */
export function shortText(el: Element, max = 40): string {
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (t) return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  const img = el.tagName === "IMG" ? el : el.querySelector("img");
  const alt = img?.getAttribute("alt")?.trim();
  if (alt) return `[img] ${alt}`;
  if (img) return "[img]";
  return "";
}

/** Tree of the body (or of `root`, e.g. the current sub-page) for the layers panel. */
export function buildLayers(doc: Document, root?: Element | null): LayerNode[] {
  const walk = (parent: Element): LayerNode[] => {
    const out: LayerNode[] = [];
    for (const child of Array.from(parent.children)) {
      if (SKIP.has(child.tagName)) continue;
      const el = child as HTMLElement;
      const uid = el.getAttribute(UID_ATTR);
      if (!uid) continue;
      const id = el.id ? `#${el.id}` : "";
      const cls = !id && el.classList.length ? `.${el.classList[0]}` : "";
      const text = el.childElementCount === 0 ? shortText(el, 24) : "";
      out.push({
        uid,
        tag: el.tagName.toLowerCase(),
        label: id || cls || text,
        hidden: el.style.display === "none" || el.hasAttribute("hidden"),
        isLink: el.tagName === "A" || el.hasAttribute(HREF_ATTR),
        children: walk(el),
      });
    }
    return out;
  };
  const from = root ?? doc.body;
  return from ? walk(from) : [];
}

/** Clones the document, strips EVERY editor artifact and returns the final HTML. */
export function serialize(doc: Document): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`[${UID_ATTR}]`).forEach((el) => el.removeAttribute(UID_ATTR));
  clone.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  clone.querySelectorAll(`[${PAGE_CURRENT_ATTR}]`).forEach((el) => el.removeAttribute(PAGE_CURRENT_ATTR));
  clone.querySelector(`#${STYLE_ID}`)?.remove();
  clone.querySelector(`base[${BASE_MARK}]`)?.remove();
  return `<!doctype html>\n${clone.outerHTML}\n`;
}

function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgba?\(([^)]+)\)/);
  if (!m) return "";
  const [r, g, b, a] = m[1].split(",").map((s) => parseFloat(s));
  if (a === 0) return ""; // transparent: leave the field empty
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
