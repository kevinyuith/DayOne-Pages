/**
 * Utilidades da edição visual: como a canvas marca, descreve e serializa o
 * documento do usuário.
 *
 * A canvas é um iframe MESMA-ORIGEM porém com `sandbox="allow-same-origin"`
 * (sem `allow-scripts`): o pai enxerga e mexe no DOM, e os scripts da página
 * do usuário NÃO rodam enquanto se edita. Ao selecionar, cada elemento do body
 * ganha um `data-dop-uid` temporário; ao salvar, `serialize` clona o documento
 * e remove TODO artefato do editor (uids, base/estilo injetados, contentEditable),
 * devolvendo o HTML exatamente como o servidor vai entregar.
 */

export const UID_ATTR = "data-dop-uid";
export const STYLE_ID = "dop-editor-style";
const BASE_MARK = "data-dop-base";

/** Elementos onde não faz sentido selecionar/editar como bloco. */
const SKIP = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "META", "LINK", "TITLE", "BASE"]);

/** Sem filhos-elemento e não-vazio: dá para editar o texto direto. */
const VOID = new Set(["IMG", "INPUT", "BR", "HR", "IFRAME", "VIDEO", "AUDIO", "SOURCE", "EMBED", "SVG", "CANVAS"]);

export type SelectionStyle = {
  color: string;
  background: string;
  fontSize: string;
  textAlign: string;
  padding: string;
};

export type SelectionInfo = {
  uid: string;
  tag: string;
  isLink: boolean;
  href: string;
  text: string;
  /** O elemento só tem texto (dá para editar num campo). */
  textEditable: boolean;
  hidden: boolean;
  style: SelectionStyle;
};

/** Marca os elementos do body com uid sequencial (idempotente por reindexação). */
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

/** Injeta `<base>` (para caminhos relativos) e o estilo do editor no <head>. */
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
    // Sem interações reais aqui: a seleção é desenhada pelo pai, por cima do
    // iframe. Só marcamos o cursor e neutralizamos âncoras durante a edição.
    style.textContent = `*{cursor:default}[${UID_ATTR}]:hover{outline:1px dashed rgba(59,130,246,.5);outline-offset:1px}[contenteditable="true"]{outline:2px solid #3b82f6;outline-offset:2px}`;
    head.appendChild(style);
  }
}

const px = (v: string) => (v && v !== "0px" ? v : "");

export function describe(el: HTMLElement): SelectionInfo {
  const win = el.ownerDocument.defaultView;
  const cs = win ? win.getComputedStyle(el) : null;
  const link = el.closest("a");
  const textEditable = el.childElementCount === 0 && !VOID.has(el.tagName);
  return {
    uid: el.getAttribute(UID_ATTR) ?? "",
    tag: el.tagName.toLowerCase(),
    isLink: el.tagName === "A" || link != null,
    href: (el.tagName === "A" ? el.getAttribute("href") : link?.getAttribute("href")) ?? "",
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

/** Conta elementos ocultados pelo editor (para o indicador "N hidden"). */
export function countHidden(doc: Document): number {
  return doc.body?.querySelectorAll('[style*="display: none"], [style*="display:none"], [hidden]').length ?? 0;
}

/** Clona o documento, tira TODO artefato do editor e devolve o HTML final. */
export function serialize(doc: Document): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`[${UID_ATTR}]`).forEach((el) => el.removeAttribute(UID_ATTR));
  clone.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  clone.querySelector(`#${STYLE_ID}`)?.remove();
  clone.querySelector(`base[${BASE_MARK}]`)?.remove();
  return `<!doctype html>\n${clone.outerHTML}\n`;
}

function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgba?\(([^)]+)\)/);
  if (!m) return "";
  const [r, g, b, a] = m[1].split(",").map((s) => parseFloat(s));
  if (a === 0) return ""; // transparente: deixa o campo vazio
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
