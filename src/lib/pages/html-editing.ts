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
 *
 * Os uids são sequenciais na ordem do documento. Por isso um documento parseado
 * com `parseHtml` (DOMParser) a partir do MESMO HTML recebe os MESMOS uids que
 * a canvas — é o que permite aos painéis (Links, Camadas) apontarem para um
 * elemento da canvas sem tocar no iframe.
 */

export const UID_ATTR = "data-dop-uid";
export const STYLE_ID = "dop-editor-style";
const BASE_MARK = "data-dop-base";

/**
 * Link "atrelado": um elemento que não é <a> mas navega ao clique. Fica no
 * HTML salvo (não é artefato do editor) junto com um <script> pequeno que
 * delega o clique — ver `lib/pages/links.ts`.
 */
export const HREF_ATTR = "data-href";
export const TARGET_ATTR = "data-target";

/**
 * Sub-páginas: seções do body marcadas com `data-dop-page="<id>"`. Uma slug
 * com várias delas mostra a inicial e troca as outras no navegador, sem mudar
 * a URL — ver `lib/pages/subpages.ts` e `lib/pages/runtime.ts`.
 */
export const PAGE_ATTR = "data-dop-page";
export const PAGE_NAME_ATTR = "data-dop-name";
export const PAGE_KIND_ATTR = "data-dop-kind";
export const PAGE_START_ATTR = "data-dop-start";
export const PAGE_TRIGGER_ATTR = "data-dop-trigger";
/**
 * Peso (0–100) de uma amostra no teste A/B: com duas ou mais seções do mesmo
 * tipo, o servidor sorteia uma por visitante na proporção dos pesos.
 */
export const PAGE_WEIGHT_ATTR = "data-dop-weight";
/**
 * No <body>, posto SÓ pelo servidor de entrega: liga o aviso de visita/clique
 * de cada amostra (`/_dop/e`). Preview e canvas não têm, então não contam.
 */
export const FUNNEL_EVENTS_ATTR = "data-dop-ev";
/** Marca (SÓ no editor) qual sub-página a canvas está mostrando. Sai no serialize. */
export const PAGE_CURRENT_ATTR = "data-dop-current";
/**
 * No <body>: como o funil troca de etapa. Ausente/"browser" = tudo no HTML e
 * o runtime troca no navegador; "server" = o servidor PHP entrega só a etapa
 * atual (cookie `dop_step`) e o runtime grava o cookie e recarrega.
 */
export const FUNNEL_MODE_ATTR = "data-dop-funnel";
/** Cookie que guarda a etapa atual no modo servidor. Igual a FUNNEL_COOKIE em server/src/funnel.php. */
export const FUNNEL_COOKIE = "dop_step";

/** O script que faz `data-href` navegar e as sub-páginas trocarem. Fica no HTML salvo. */
export const RUNTIME_ATTR = "data-dop-runtime";

/** Elementos onde não faz sentido selecionar/editar como bloco. */
const SKIP = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "META", "LINK", "TITLE", "BASE", "TEMPLATE", "NOSCRIPT"]);

/** Sem filhos-elemento e não-vazio: dá para editar o texto direto. */
const VOID = new Set(["IMG", "INPUT", "BR", "HR", "IFRAME", "VIDEO", "AUDIO", "SOURCE", "EMBED", "SVG", "CANVAS"]);

export type SelectionStyle = {
  color: string;
  background: string;
  fontSize: string;
  textAlign: string;
  padding: string;
};

/**
 * De onde vem o link do elemento selecionado:
 * - `anchor`: ele mesmo é <a>/<area> (ou <form>, via `action`);
 * - `inherited`: está DENTRO de um <a> — editar mexe no <a> pai;
 * - `attached`: tem `data-href` (link atrelado pelo editor);
 * - `none`: sem link — dá para atrelar um.
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
  /** O elemento só tem texto (dá para editar num campo). */
  textEditable: boolean;
  hidden: boolean;
  style: SelectionStyle;
};

/** Um nó da árvore de camadas (painel Layers). */
export type LayerNode = {
  uid: string;
  tag: string;
  /** `#id`, `.classe` ou um trecho do texto — o que identificar melhor. */
  label: string;
  hidden: boolean;
  isLink: boolean;
  children: LayerNode[];
};

export function isSkipped(el: Element): boolean {
  return SKIP.has(el.tagName);
}

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

/**
 * Parseia HTML num Document inerte (scripts não rodam) já com uids — os mesmos
 * que a canvas atribui ao mesmo HTML. Só no cliente (DOMParser).
 */
export function parseHtml(html: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  assignUids(doc);
  return doc;
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
    style.textContent = [
      `*{cursor:default}`,
      `[${UID_ATTR}]:hover{outline:1px dashed rgba(59,130,246,.5);outline-offset:1px}`,
      `[contenteditable="true"]{outline:2px solid #3b82f6;outline-offset:2px}`,
      `[${HREF_ATTR}]{cursor:pointer}`,
      // Sub-páginas: a canvas mostra só a atual (o `hidden` gravado é ignorado aqui).
      `[${PAGE_ATTR}]:not([${PAGE_CURRENT_ATTR}]){display:none!important}`,
      `[${PAGE_ATTR}][${PAGE_CURRENT_ATTR}]{display:block!important}`,
    ].join("");
    head.appendChild(style);
  }
}

const px = (v: string) => (v && v !== "0px" ? v : "");

/** O elemento que carrega o link de `el`: ele mesmo, o <a> que o envolve, ou nada. */
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

/** Conta elementos ocultados pelo editor (para o indicador "N hidden"). */
export function countHidden(doc: Document): number {
  // Sub-páginas não-iniciais são `hidden` por design — não contam.
  return doc.body?.querySelectorAll(`[style*="display: none"]:not([${PAGE_ATTR}]), [style*="display:none"]:not([${PAGE_ATTR}]), [hidden]:not([${PAGE_ATTR}])`).length ?? 0;
}

/** Texto curto de um elemento, para rótulos de painel. */
export function shortText(el: Element, max = 40): string {
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (t) return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  const img = el.tagName === "IMG" ? el : el.querySelector("img");
  const alt = img?.getAttribute("alt")?.trim();
  if (alt) return `[img] ${alt}`;
  if (img) return "[img]";
  return "";
}

/** Árvore do body (ou de `root`, ex.: a sub-página atual) para o painel de camadas. */
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

/** Clona o documento, tira TODO artefato do editor e devolve o HTML final. */
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
  if (a === 0) return ""; // transparente: deixa o campo vazio
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
