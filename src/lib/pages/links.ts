/**
 * Links da página: como o editor encontra, agrupa e troca os links de um
 * documento — e como "atrela" um link a um elemento que não é <a>.
 *
 * Dois tipos de link convivem no HTML salvo:
 *
 *  - NATIVOS: `<a href>`, `<area href>`, `<form action>`. Editar troca o
 *    atributo e pronto.
 *  - ATRELADOS: qualquer elemento com `data-href` (e `data-target` opcional).
 *    O runtime da página (`lib/pages/runtime.ts`), gravado junto com o HTML,
 *    delega o clique e navega. Assim um botão, imagem ou bloco vira link SEM
 *    mudar a estrutura nem o CSS do HTML — e a slug continua a mesma; só o
 *    destino dos cliques muda. Destinos `#next-step` / `#page:<id>` trocam
 *    a sub-página (ver `subpages.ts`).
 *
 * Tudo aqui opera sobre um `Document`: o da canvas (ao vivo, sem recarregar o
 * iframe) ou um parseado com `parseHtml` a partir do HTML salvo (modo código).
 * Os uids são os mesmos nos dois, então uma entrada da lista aponta para o
 * elemento certo na canvas.
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
  /** Rótulo curto: texto, alt da imagem ou o tag. */
  label: string;
  external: boolean;
  /** Nome da sub-página que contém o link (vazio numa slug de página única). */
  page: string;
};

export type LinkGroup = { href: string; entries: LinkEntry[] };

const LINK_SELECTOR = `a[href], area[href], form[action], [${HREF_ATTR}]`;

export function isExternal(href: string): boolean {
  return /^(https?:)?\/\//i.test(href) || /^(mailto|tel|sms|whatsapp):/i.test(href);
}

/** Todos os links do body, na ordem do documento. */
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

/** Agrupa por destino, na ordem em que cada destino aparece pela primeira vez. */
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
 * Grava o link num elemento que JÁ carrega link (o `holder`): <a>/<area> no
 * href, <form> no action, atrelado no data-href. `target` undefined = não mexe.
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
 * Define o link do elemento `uid`. Se ele é (ou está dentro de) um <a>, mexe
 * no <a>; senão atrela via data-href. `href` vazio remove o link.
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

/** Troca TODOS os links cujo destino é exatamente `from` por `to`. Devolve quantos mudaram. */
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

/** Aponta todos os links da página para `to`. Devolve quantos mudaram. */
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

/** Aplica `fn` num Document parseado do HTML e devolve o HTML resultante (modo código). */
export function mutateHtml(html: string, fn: (doc: Document) => void): string {
  const doc = parseHtml(html);
  fn(doc);
  normalizePages(doc);
  syncRuntime(doc);
  return serialize(doc);
}
