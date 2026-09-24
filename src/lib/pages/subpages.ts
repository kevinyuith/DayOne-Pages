/**
 * O funil de uma slug — o "sem mudar a slug" do builder de referência.
 *
 * O funil tem SEMPRE as mesmas três etapas, nesta ordem: Pre Lander → Lander
 * → Backredirect. Uma etapa sem código (sem seção, ou seção vazia/só
 * comentário) fica INATIVA e é pulada. Quem o visitante vê primeiro:
 * 1) o Pre Lander, se ativo; 2) senão, o Lander. O Backredirect só aparece
 * pelo botão voltar (ou exit intent). Uma slug sem seções é só o Lander.
 *
 * Uma slug continua sendo UM documento HTML (o servidor serve como está). As
 * etapas são seções irmãs no body:
 *
 *   <section data-dop-page="p_ab12" data-dop-name="Pre Lander" data-dop-kind="presell" data-dop-start>…</section>
 *   <section data-dop-page="p_cd34" data-dop-name="Lander" data-dop-kind="main" hidden>…</section>
 *   <section data-dop-page="p_ef56" data-dop-name="Backredirect" data-dop-kind="backredirect" data-dop-trigger="back exit" hidden>…</section>
 *   <script data-dop-runtime>…</script>
 *
 * O `hidden` das não-iniciais é o fallback sem JS. Com JS, o runtime mostra a
 * inicial e troca no clique (`#next-step`: do Pre Lander para o Lander;
 * `#page:<id>`), sem mudar a URL. O <head> (estilos) é compartilhado — páginas
 * clonadas de sites diferentes podem conflitar no CSS; prefira classes com
 * prefixo. As mesmas regras (ativa = tem código, prioridade da inicial) valem
 * em `runtime.ts` e em `server/src/funnel.php`.
 *
 * Dois modos de troca, gravados em `<body data-dop-funnel>` (ver FunnelMode):
 *  - browser (padrão): o HTML inteiro vai para o visitante; a troca é só JS.
 *  - server: o servidor PHP corta o HTML e entrega SÓ a etapa atual, escolhida
 *    pelo cookie `dop_step`; o runtime grava o cookie e recarrega a mesma URL.
 *    O fonte do pre lander não contém o lander. Só faz diferença no servidor —
 *    canvas e preview continuam mostrando tudo.
 *
 * Tudo aqui opera num Document (canvas ao vivo ou parseado do HTML) e devolve
 * o suficiente para o painel: `listPages`. As mutações não gravam nada — quem
 * chama serializa (a canvas via `commit`, o modo código via `mutateHtml`).
 */

import { FUNNEL_MODE_ATTR, PAGE_ATTR, PAGE_CURRENT_ATTR, PAGE_KIND_ATTR, PAGE_NAME_ATTR, PAGE_START_ATTR, PAGE_TRIGGER_ATTR, RUNTIME_ATTR, UID_ATTR } from "./html-editing";
import { NEXT_STEP, PAGE_HREF_PREFIX } from "./runtime";

/** As etapas, na ordem fixa do funil. Um tipo que não está aqui (HTML antigo) é lido como "main". */
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
  /** Tem código? Sem código a etapa fica inativa: o visitante nunca a vê. */
  active: boolean;
  /** É a que o visitante vê primeiro (Pre Lander ativo, senão Lander). */
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

function kindOf(el: Element): SubPageKind {
  const k = el.getAttribute(PAGE_KIND_ATTR);
  return k === "presell" || k === "backredirect" ? k : "main";
}

/** A etapa tem código: algum elemento, ou texto que não seja só espaço. Comentário não conta. */
export function hasCode(el: Element): boolean {
  return Array.from(el.childNodes).some((n) => n.nodeType === 1 || (n.nodeType === 3 && /\S/.test(n.nodeValue ?? "")));
}

function describePage(el: HTMLElement, isStart: boolean): SubPage {
  const kind = kindOf(el);
  const trig = (el.getAttribute(PAGE_TRIGGER_ATTR) ?? "").split(/\s+/).filter((t): t is BackTrigger => t === "back" || t === "exit");
  return {
    id: el.getAttribute(PAGE_ATTR) ?? "",
    uid: el.getAttribute(UID_ATTR) ?? "",
    name: SUB_KIND_LABELS[kind],
    kind,
    active: hasCode(el),
    isStart,
    triggers: trig,
  };
}

export function listPages(doc: Document): SubPage[] {
  const start = startPage(doc);
  return pageElements(doc).map((el) => describePage(el, el === start));
}

/**
 * A inicial, por prioridade: 1) o Pre Lander, se ativo; 2) o Lander, se ativo.
 * Sem nenhum dos dois ativo (só no editor), a primeira que não é Backredirect.
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
  /** A seção da etapa (null: não existe; ou é o Lander de uma slug sem seções). */
  page: SubPage | null;
  active: boolean;
  isStart: boolean;
};

/**
 * As três etapas, sempre nesta ordem, a partir da lista do documento. Numa
 * slug sem seções o documento inteiro é o Lander (ativo, sem seção).
 */
export function funnelSlots(pages: SubPage[]): FunnelSlot[] {
  return PAGE_KINDS_SUB.map((kind) => {
    const page = pages.find((p) => p.kind === kind && p.active) ?? pages.find((p) => p.kind === kind) ?? null;
    const plainLander = kind === "main" && pages.length === 0;
    return { kind, label: SUB_KIND_LABELS[kind], page, active: plainLander || !!page?.active, isStart: plainLander || !!page?.isStart };
  });
}

function newId(doc: Document): string {
  let id = "";
  do id = `p_${Math.random().toString(36).slice(2, 6)}`;
  while (pageById(doc, id));
  return id;
}

/**
 * Deixa o documento consistente: tipo e nome fixos por etapa, exatamente uma
 * inicial (pela prioridade), `hidden` nas outras (fallback sem JS) e trigger
 * só na Backredirect. Idempotente; roda antes de cada serialize.
 */
export function normalizePages(doc: Document): void {
  const els = pageElements(doc);
  if (!els.length) return;
  const start = startPage(doc);
  for (const el of els) {
    const kind = kindOf(el);
    el.setAttribute(PAGE_KIND_ATTR, kind);
    el.setAttribute(PAGE_NAME_ATTR, SUB_KIND_LABELS[kind]);
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
 * Converte uma slug de página única no Lander: tudo que está no body (menos o
 * runtime) vai para dentro de uma <section>. Devolve o id.
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
 * Ativa uma etapa com um código inicial para editar (a seção vazia ganha o
 * código; sem seção, uma nova entra na posição da ordem fixa). Numa slug de
 * página única, o documento vira o Lander antes. Devolve o id da etapa.
 */
export function activateStep(doc: Document, kind: SubPageKind): string {
  if (!doc.body) return "";
  if (!hasPages(doc)) {
    const lander = wrapAsFirstPage(doc);
    if (kind === "main") return lander;
  }
  const els = pageElements(doc);
  const existing = els.find((el) => kindOf(el) === kind && hasCode(el)) ?? els.find((el) => kindOf(el) === kind);
  if (existing) {
    if (!hasCode(existing)) existing.innerHTML = STARTER[kind]();
    normalizePages(doc);
    return existing.getAttribute(PAGE_ATTR) ?? "";
  }
  const section = doc.createElement("section");
  const id = newId(doc);
  section.setAttribute(PAGE_ATTR, id);
  section.setAttribute(PAGE_NAME_ATTR, SUB_KIND_LABELS[kind]);
  section.setAttribute(PAGE_KIND_ATTR, kind);
  if (kind === "backredirect") section.setAttribute(PAGE_TRIGGER_ATTR, "back");
  section.innerHTML = STARTER[kind]();
  // Entra antes da primeira etapa que vem depois dela na ordem fixa (senão no fim).
  const order = PAGE_KINDS_SUB.indexOf(kind);
  const later = els.find((el) => PAGE_KINDS_SUB.indexOf(kindOf(el)) > order);
  if (later) later.before(section);
  else els[els.length - 1].after(section);
  normalizePages(doc);
  return id;
}

/**
 * Desativa uma etapa: apaga a seção (e o código). A última etapa ativa que o
 * visitante pode ver (Pre Lander ou Lander) não sai — sem ela a página ficaria
 * em branco. Se sobrar só o Lander, a slug volta a ser página única.
 */
export function deactivateStep(doc: Document, kind: SubPageKind): void {
  const els = pageElements(doc);
  const mine = els.filter((el) => kindOf(el) === kind);
  if (!mine.length) return;
  const flowLeft = els.some((el) => kindOf(el) !== kind && kindOf(el) !== "backredirect" && hasCode(el));
  if (kind !== "backredirect" && mine.some(hasCode) && !flowLeft) return;
  mine.forEach((el) => el.remove());
  const rest = pageElements(doc);
  const active = rest.filter(hasCode);
  if (active.length === 1 && kindOf(active[0]) === "main") {
    rest.filter((el) => el !== active[0]).forEach((el) => el.remove());
    unwrapSingle(doc, active[0]);
  }
  normalizePages(doc);
}

function unwrapSingle(doc: Document, section: HTMLElement): void {
  section.replaceWith(...Array.from(section.childNodes));
  doc.body?.removeAttribute(FUNNEL_MODE_ATTR);
}

export function setTriggers(doc: Document, id: string, triggers: BackTrigger[]): void {
  const el = pageById(doc, id);
  if (!el) return;
  if (triggers.length) el.setAttribute(PAGE_TRIGGER_ATTR, triggers.join(" "));
  else el.removeAttribute(PAGE_TRIGGER_ATTR);
}

/**
 * Só para o preview: começa na etapa `id`. Se ela é o Lander, o Pre Lander sai
 * do documento do preview (a prioridade então cai no Lander). O Backredirect
 * nunca é inicial: o preview começa normal e ele aparece ao voltar.
 */
export function previewFrom(doc: Document, id: string): void {
  const el = pageById(doc, id);
  if (!el || kindOf(el) !== "main") return;
  pageElements(doc)
    .filter((p) => kindOf(p) === "presell")
    .forEach((p) => p.remove());
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
