/**
 * Sub-páginas de uma slug — o "sem mudar a slug" do builder de referência.
 *
 * Uma slug continua sendo UM documento HTML (o servidor serve como está). As
 * sub-páginas são seções irmãs no body:
 *
 *   <section data-dop-page="p_ab12" data-dop-name="Presell" data-dop-kind="presell" data-dop-start>…</section>
 *   <section data-dop-page="p_cd34" data-dop-name="VSL" data-dop-kind="main" hidden>…</section>
 *   <section data-dop-page="p_ef56" data-dop-name="Volta" data-dop-kind="backredirect" data-dop-trigger="back exit" hidden>…</section>
 *   <script data-dop-runtime>…</script>
 *
 * O `hidden` das não-iniciais é o fallback sem JS. Com JS, o runtime mostra a
 * inicial e troca as outras no clique (`#next-step`, `#page:<id>`), sem mudar
 * a URL. O <head> (estilos) é compartilhado — páginas clonadas de sites
 * diferentes podem conflitar no CSS; prefira classes com prefixo.
 *
 * Dois modos de troca, gravados em `<body data-dop-funnel>` (ver FunnelMode):
 *  - browser (padrão): o HTML inteiro vai para o visitante; a troca é só JS.
 *  - server: o servidor PHP corta o HTML e entrega SÓ a etapa atual, escolhida
 *    pelo cookie `dop_step`; o runtime grava o cookie e recarrega a mesma URL.
 *    O fonte da presell não contém a principal. Só faz diferença no servidor —
 *    canvas e preview continuam mostrando tudo.
 *
 * Tudo aqui opera num Document (canvas ao vivo ou parseado do HTML) e devolve
 * o suficiente para o painel: `listPages`. As mutações não gravam nada — quem
 * chama serializa (a canvas via `commit`, o modo código via `mutateHtml`).
 */

import { FUNNEL_MODE_ATTR, PAGE_ATTR, PAGE_CURRENT_ATTR, PAGE_KIND_ATTR, PAGE_NAME_ATTR, PAGE_START_ATTR, PAGE_TRIGGER_ATTR, RUNTIME_ATTR, UID_ATTR } from "./html-editing";
import { NEXT_STEP, PAGE_HREF_PREFIX } from "./runtime";

export const PAGE_KINDS_SUB = ["main", "presell", "upsell", "downsell", "backredirect"] as const;
export type SubPageKind = (typeof PAGE_KINDS_SUB)[number];
export const SUB_KIND_LABELS: Record<SubPageKind, string> = {
  main: "Principal",
  presell: "Presell",
  upsell: "Upsell",
  downsell: "Downsell",
  backredirect: "Back redirect",
};

export type BackTrigger = "back" | "exit";

export const FUNNEL_MODES = ["browser", "server"] as const;
export type FunnelMode = (typeof FUNNEL_MODES)[number];
export const FUNNEL_MODE_LABELS: Record<FunnelMode, string> = { browser: "No navegador", server: "No servidor" };

export function getFunnelMode(doc: Document): FunnelMode {
  return doc.body?.getAttribute(FUNNEL_MODE_ATTR) === "server" ? "server" : "browser";
}

/** Grava o modo no <body>; "browser" é o padrão e não deixa atributo. */
export function setFunnelMode(doc: Document, mode: FunnelMode): void {
  const body = doc.body;
  if (!body) return;
  if (mode === "server") body.setAttribute(FUNNEL_MODE_ATTR, "server");
  else body.removeAttribute(FUNNEL_MODE_ATTR);
}

export type SubPage = {
  id: string;
  uid: string;
  name: string;
  kind: SubPageKind;
  isStart: boolean;
  triggers: BackTrigger[];
};

const SEL = `[${PAGE_ATTR}]`;

export function pageElements(doc: Document): HTMLElement[] {
  return Array.from(doc.body?.querySelectorAll<HTMLElement>(SEL) ?? []).filter((el) => !el.parentElement?.closest(SEL));
}

export function pageById(doc: Document, id: string): HTMLElement | null {
  return doc.body?.querySelector<HTMLElement>(`[${PAGE_ATTR}="${CSS.escape(id)}"]`) ?? null;
}

/** A sub-página que contém `el` (ou null numa slug sem sub-páginas). */
export function pageOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(SEL);
}

export function hasPages(doc: Document): boolean {
  return pageElements(doc).length > 0;
}

function isKind(v: string | null): v is SubPageKind {
  return (PAGE_KINDS_SUB as readonly string[]).includes(v ?? "");
}

export function describePage(el: HTMLElement): SubPage {
  const kind = el.getAttribute(PAGE_KIND_ATTR);
  const trig = (el.getAttribute(PAGE_TRIGGER_ATTR) ?? "").split(/\s+/).filter((t): t is BackTrigger => t === "back" || t === "exit");
  return {
    id: el.getAttribute(PAGE_ATTR) ?? "",
    uid: el.getAttribute(UID_ATTR) ?? "",
    name: el.getAttribute(PAGE_NAME_ATTR) || "Sem nome",
    kind: isKind(kind) ? kind : "main",
    isStart: el.hasAttribute(PAGE_START_ATTR),
    triggers: trig,
  };
}

export function listPages(doc: Document): SubPage[] {
  return pageElements(doc).map(describePage);
}

/** A inicial: a marcada, senão a primeira que não é back redirect, senão a primeira. */
export function startPage(doc: Document): HTMLElement | null {
  const els = pageElements(doc);
  return els.find((el) => el.hasAttribute(PAGE_START_ATTR)) ?? els.find((el) => el.getAttribute(PAGE_KIND_ATTR) !== "backredirect") ?? els[0] ?? null;
}

function newId(doc: Document): string {
  let id = "";
  do id = `p_${Math.random().toString(36).slice(2, 6)}`;
  while (pageById(doc, id));
  return id;
}

/**
 * Deixa o documento consistente: exatamente uma inicial, `hidden` nas outras
 * (fallback sem JS) e nenhum `hidden` na inicial. Idempotente; roda antes de
 * cada serialize.
 */
export function normalizePages(doc: Document): void {
  const els = pageElements(doc);
  if (!els.length) return;
  const start = startPage(doc);
  for (const el of els) {
    if (el === start) {
      el.setAttribute(PAGE_START_ATTR, "");
      el.removeAttribute("hidden");
    } else {
      el.removeAttribute(PAGE_START_ATTR);
      el.setAttribute("hidden", "");
    }
    if (el.getAttribute(PAGE_KIND_ATTR) !== "backredirect") el.removeAttribute(PAGE_TRIGGER_ATTR);
  }
}

/**
 * Converte uma slug de página única na primeira sub-página: tudo que está no
 * body (menos o runtime) vai para dentro de uma <section>. Devolve o id.
 */
export function wrapAsFirstPage(doc: Document, name = "Principal", kind: SubPageKind = "main"): string {
  const body = doc.body;
  if (!body) return "";
  const existing = pageElements(doc);
  if (existing.length) return existing[0].getAttribute(PAGE_ATTR) ?? "";
  const section = doc.createElement("section");
  const id = newId(doc);
  section.setAttribute(PAGE_ATTR, id);
  section.setAttribute(PAGE_NAME_ATTR, name);
  section.setAttribute(PAGE_KIND_ATTR, kind);
  section.setAttribute(PAGE_START_ATTR, "");
  const nodes = Array.from(body.childNodes).filter((n) => !(n instanceof Element && n.matches(`script[${RUNTIME_ATTR}]`)));
  body.prepend(section);
  section.append(...nodes);
  return id;
}

const STARTER: Record<SubPageKind, (name: string) => string> = {
  main: (n) => block(n, "Esta é a página principal (a oferta). Coloque aqui a VSL ou a carta de vendas.", "Quero a oferta", "#"),
  presell: (n) => block(n, "Esta é uma presell. Aqueça o visitante e mande para o próximo passo.", "Continuar", NEXT_STEP),
  upsell: (n) => block(n, "Oferta adicional depois da compra.", "Sim, quero adicionar", "#"),
  downsell: (n) => block(n, "Alternativa mais barata para quem recusou o upsell.", "Aceitar esta oferta", "#"),
  backredirect: (n) => block(n, "Esta página aparece quando o visitante aperta voltar (ou tenta sair). Segure-o com uma última oferta.", "Ver a oferta", NEXT_STEP),
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

/** Adiciona uma sub-página (embrulhando a página única antes, se preciso). Devolve o id. */
export function addPage(doc: Document, opts: { name: string; kind: SubPageKind; html?: string; after?: string }): string {
  const body = doc.body;
  if (!body) return "";
  if (!hasPages(doc)) wrapAsFirstPage(doc);
  const section = doc.createElement("section");
  const id = newId(doc);
  section.setAttribute(PAGE_ATTR, id);
  section.setAttribute(PAGE_NAME_ATTR, opts.name);
  section.setAttribute(PAGE_KIND_ATTR, opts.kind);
  if (opts.kind === "backredirect") section.setAttribute(PAGE_TRIGGER_ATTR, "back");
  section.innerHTML = opts.html ?? STARTER[opts.kind](opts.name);
  // Onde entra: a ordem no body É a ordem do funil (`#next-step` avança para a
  // próxima). Presell vai ANTES da inicial; back redirect vai para o fim; o
  // resto entra depois da sub-página atual (ou no fim).
  const els = pageElements(doc);
  const anchor = opts.after ? pageById(doc, opts.after) : null;
  const first = startPage(doc) ?? els[0];
  if (opts.kind === "presell" && first) first.before(section);
  else if (opts.kind === "backredirect" && els.length) els[els.length - 1].after(section);
  else if (anchor) anchor.after(section);
  else if (els.length) els[els.length - 1].after(section);
  else body.prepend(section);
  normalizePages(doc);
  return id;
}

export function removePage(doc: Document, id: string): void {
  const el = pageById(doc, id);
  if (!el) return;
  const others = pageElements(doc).filter((p) => p !== el);
  el.remove();
  // Sobrou uma só: volta a ser página única (desembrulha).
  if (others.length === 1) unwrapSingle(doc, others[0]);
  normalizePages(doc);
}

function unwrapSingle(doc: Document, section: HTMLElement): void {
  section.replaceWith(...Array.from(section.childNodes));
  doc.body?.removeAttribute(FUNNEL_MODE_ATTR);
}

export function renamePage(doc: Document, id: string, name: string): void {
  pageById(doc, id)?.setAttribute(PAGE_NAME_ATTR, name.trim() || "Sem nome");
}

export function setPageKind(doc: Document, id: string, kind: SubPageKind): void {
  const el = pageById(doc, id);
  if (!el) return;
  el.setAttribute(PAGE_KIND_ATTR, kind);
  if (kind === "backredirect") {
    if (!el.hasAttribute(PAGE_TRIGGER_ATTR)) el.setAttribute(PAGE_TRIGGER_ATTR, "back");
    // Uma back redirect não pode ser a inicial.
    if (el.hasAttribute(PAGE_START_ATTR)) el.removeAttribute(PAGE_START_ATTR);
  }
  normalizePages(doc);
}

export function setStart(doc: Document, id: string): void {
  const el = pageById(doc, id);
  if (!el || el.getAttribute(PAGE_KIND_ATTR) === "backredirect") return;
  pageElements(doc).forEach((p) => p.removeAttribute(PAGE_START_ATTR));
  el.setAttribute(PAGE_START_ATTR, "");
  normalizePages(doc);
}

export function setTriggers(doc: Document, id: string, triggers: BackTrigger[]): void {
  const el = pageById(doc, id);
  if (!el) return;
  if (triggers.length) el.setAttribute(PAGE_TRIGGER_ATTR, triggers.join(" "));
  else el.removeAttribute(PAGE_TRIGGER_ATTR);
}

export function movePage(doc: Document, id: string, dir: "up" | "down"): void {
  const el = pageById(doc, id);
  if (!el) return;
  const els = pageElements(doc);
  const i = els.indexOf(el);
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= els.length) return;
  if (dir === "up") els[j].before(el);
  else els[j].after(el);
}

export function duplicatePage(doc: Document, id: string): string {
  const el = pageById(doc, id);
  if (!el) return "";
  const clone = el.cloneNode(true) as HTMLElement;
  const nid = newId(doc);
  clone.setAttribute(PAGE_ATTR, nid);
  clone.setAttribute(PAGE_NAME_ATTR, `${el.getAttribute(PAGE_NAME_ATTR) ?? "Página"} (cópia)`);
  clone.removeAttribute(PAGE_START_ATTR);
  clone.removeAttribute(PAGE_CURRENT_ATTR);
  el.after(clone);
  normalizePages(doc);
  return nid;
}

/** Marca (só no editor) a sub-página que a canvas mostra. */
export function setCurrent(doc: Document, id: string | null): void {
  pageElements(doc).forEach((p) => {
    if (id && p.getAttribute(PAGE_ATTR) === id) p.setAttribute(PAGE_CURRENT_ATTR, "");
    else p.removeAttribute(PAGE_CURRENT_ATTR);
  });
}

/** O href que leva a uma sub-página, para o seletor de destino. */
export function pageHref(id: string): string {
  return `${PAGE_HREF_PREFIX}${id}`;
}

/** Se `href` aponta para uma sub-página (`#page:<id>`), devolve o id. */
export function pageIdFromHref(href: string): string | null {
  return href.startsWith(PAGE_HREF_PREFIX) ? href.slice(PAGE_HREF_PREFIX.length) : null;
}

/**
 * Troca todos os ids de sub-página (`p_xxxx`) de um HTML por ids novos — nos
 * `data-dop-page` e em todo `#page:<id>` que aponte para eles. Sem DOM, para
 * rodar no servidor (duplicar página): duas slugs com os MESMOS ids de etapa
 * compartilhariam o cookie `dop_step` no modo servidor.
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
  // Só onde um id aparece como id: atributo data-dop-page, cookie/href #page:<id>.
  return html
    .replace(/(\bdata-dop-page\s*=\s*")(p_[a-z0-9]{1,16})(")/gi, (_, a: string, id: string, z: string) => a + (map.get(id) ?? id) + z)
    .replace(/(#page:)(p_[a-z0-9]{1,16})\b/g, (_, a: string, id: string) => a + (map.get(id) ?? id));
}
