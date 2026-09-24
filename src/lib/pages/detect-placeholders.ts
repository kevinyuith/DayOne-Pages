import { SUFFIXES_ANY_CASE, SUFFIXES_EXACT, companyName } from "./company-name";

/**
 * "Criar template" por link ou por HTML colado: acha no conteúdo textos que
 * parecem dados da empresa (e o ano do copyright e o domínio de origem) e
 * sugere trocá-los pelos marcadores {{...}}. O usuário confirma cada um antes
 * — a detecção é por padrão de texto e erra; nada é trocado sem o "sim".
 *
 * Procura só no texto visível e em alt/title/aria-label/placeholder e nas
 * metas de descrição/og/twitter; e-mail e telefone também nos links mailto:
 * e tel:. Nunca dentro de <script>/<style> nem em outros atributos (classe,
 * src, href comum).
 *
 * `findPlaceholderCandidates` é puro (lista de textos → achados); a leitura e
 * a reescrita do HTML (DOMParser) ficam em `detectPlaceholders` /
 * `applyPlaceholderFindings`, só no cliente.
 */

export type PlaceholderFinding = {
  /** Chave estável da linha (tipo + texto). */
  id: string;
  /** O marcador que entra (ex.: "company.email"). */
  key: string;
  /** O texto encontrado. */
  text: string;
  /** O que fica no lugar (quase sempre `{{key}}`; no copyright, "© {{year}}"). */
  replacement: string;
  /** Quantas vezes aparece (depois que os achados maiores já foram trocados). */
  count: number;
};

// ── Padrões ──────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Sufixos para ACHAR uma razão social: como se escrevem de fato (e em
 * maiúsculas), com ponto opcional. "Company" fica de fora: "About Our
 * Company" não é razão social.
 */
const DETECT_SUFFIXES = [
  ...new Set([
    ...SUFFIXES_ANY_CASE.filter((s) => s !== "Company").flatMap((s) => [s, s.toUpperCase()]),
    ...SUFFIXES_EXACT,
  ]),
].sort((a, b) => b.length - a.length);
const SUFFIX = `(?:${DETECT_SUFFIXES.map(escapeRe).join("|")})\\.?(?![\\p{L}\\p{N}])`;

// Palavra de nome: começa com maiúscula ou número e tem letra; conectores minúsculos entre elas.
const CAP_WORD = String.raw`(?!${SUFFIX})(?=[\p{L}\p{N}&'’.\-]*\p{L})[\p{Lu}\p{N}][\p{L}\p{N}&'’.\-]*`;
const JOINER = String.raw`(?:&|of|and|the|de|da|do|dos|das|del|e|y)`;
const LEGAL_RE = new RegExp(
  `${CAP_WORD}(?:\\s+(?:${CAP_WORD}|${JOINER})){0,6}(?:(?:,?\\s+|\\s*[-–—&]\\s*)${SUFFIX}){1,3}`,
  "gu",
);
/** Palavras que abrem frase, não nome ("Copyright Acme LLC" → "Acme LLC"). */
const LEADING_NOISE = new Set(
  "copyright contact about welcome visit by from at powered operated owned managed sold offered provided brought presented all rights reserved".split(" "),
);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,24})/g;
const NOT_EMAIL_TLD = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "css", "js", "avif"]);

const PHONE_RE = /(?<![\p{L}\p{N}])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}(?![\p{L}\p{N}])/gu;

const NUMBER_RE =
  /\b(EIN|TIN|Tax ID|CNPJ|VAT(?:\s+(?:No\.?|Number|ID))?|ABN|ACN|NIF|NIPC|CRN|Company\s+(?:No\.?|Number|Reg(?:istration)?\.?\s*(?:No\.?|Number))|Registration\s+(?:No\.?|Number)|Reg\.?\s+No\.?)\s*[:#.]?\s*([A-Z]{0,3}\s?\d[\d./-]{3,22}\d)/giu;

const US_ADDRESS_RE =
  /\b\d{1,6}\s+(?:[\p{L}\p{N}.'#-]+\s+){1,6}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Terrace|Suite|Ste)\b\.?[^<>\n]{0,80}?\b[A-Z]{2}\s+\d{5}(?:-\d{4})?/gu;
const BR_ADDRESS_RE = /\b(?:Rua|R\.|Avenida|Av\.|Alameda|Al\.|Travessa|Rodovia|Praça|Estrada)\s[^<>\n]{3,120}?CEP:?\s*\d{5}-?\d{3}/giu;

const COPYRIGHT_RE = /(©|\(c\)|Copyright)\s*((?:\d{4}\s*[-–]\s*)?)(\d{4})(?!\d)/giu;

// ── Achar (puro) ─────────────────────────────────────────────────────────────

type Candidate = { key: string; text: string; replacement?: string };

function cleanLegal(match: string): string | null {
  const words = match.trim().split(/\s+/);
  while (words.length > 1 && LEADING_NOISE.has(words[0].toLowerCase())) words.shift();
  // Sem o ponto do fim: quase sempre é o da frase ("… LLC. All rights reserved"), e a página fica com ele.
  const legal = words.join(" ").replace(/^[&,\-–—\s]+/, "").replace(/\.$/, "");
  if (legal.length < 4 || legal.length > 90) return null;
  const name = companyName(legal);
  return name !== legal && /\p{L}{2,}/u.test(name) ? legal : null;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Mesmo telefone com ou sem o código do país ("+1 555…" e "(555)…"). */
function samePhone(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  return da === db || (Math.min(da.length, db.length) >= 10 && (da.endsWith(db) || db.endsWith(da)));
}

function phoneLike(s: string): boolean {
  const n = digits(s).length;
  // 10 a 15 dígitos e algum sinal de telefone (+, parênteses ou separador): tira datas, preços e ids.
  return n >= 10 && n <= 15 && /[+()\s.-]/.test(s) && !/^\d{4}[-./]\d{2}[-./]\d{2}/.test(s);
}

/**
 * Candidatos a marcador nos textos. `sourceHost` (link) faz o domínio de
 * origem virar {{domain}}.
 */
export function findPlaceholderCandidates(texts: string[], opts: { sourceHost?: string; mailtos?: string[]; tels?: string[] } = {}): Candidate[] {
  const out = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const text = c.text.trim();
    if (text) out.set(`${c.key}|${text}`, { ...c, text });
  };

  for (const t of texts) {
    for (const m of t.matchAll(LEGAL_RE)) {
      const legal = cleanLegal(m[0]);
      if (legal) {
        add({ key: "company.llc", text: legal });
        add({ key: "company.name", text: companyName(legal) });
      }
    }
    for (const m of t.matchAll(EMAIL_RE)) if (!NOT_EMAIL_TLD.has(m[1].toLowerCase())) add({ key: "company.email", text: m[0] });
    for (const m of t.matchAll(NUMBER_RE)) add({ key: "company.number", text: m[2] });
    for (const m of t.matchAll(US_ADDRESS_RE)) add({ key: "company.address", text: m[0] });
    for (const m of t.matchAll(BR_ADDRESS_RE)) add({ key: "company.address", text: m[0] });
    for (const m of t.matchAll(COPYRIGHT_RE)) add({ key: "year", text: m[0], replacement: `${m[1]} ${m[2]}{{year}}` });
  }
  // Telefone depois do número de registro: um CNPJ não pode virar telefone.
  const numbers = [...out.values()].filter((c) => c.key === "company.number").map((c) => digits(c.text));
  for (const t of texts) {
    for (const m of t.matchAll(PHONE_RE)) {
      if (phoneLike(m[0]) && !numbers.includes(digits(m[0]))) add({ key: "company.phone", text: m[0] });
    }
  }
  for (const e of opts.mailtos ?? []) add({ key: "company.email", text: e });
  // tel: sem o mesmo telefone visível na página vira achado próprio.
  const phones = [...out.values()].filter((c) => c.key === "company.phone").map((c) => c.text);
  for (const p of opts.tels ?? []) if (phoneLike(p) && !phones.some((v) => samePhone(v, p))) add({ key: "company.phone", text: p });

  const host = opts.sourceHost?.replace(/^www\./i, "").toLowerCase();
  if (host && texts.some((t) => t.toLowerCase().includes(host))) add({ key: "domain", text: host });

  return [...out.values()];
}

// ── Contar e trocar ──────────────────────────────────────────────────────────

/** Troca, num texto, cada achado (do maior para o menor) respeitando bordas de palavra. */
function replaceFindings(value: string, findings: PlaceholderFinding[], counts?: Map<string, number>): string {
  let out = value;
  for (const f of findings) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_@])${escapeRe(f.text)}(?![\\p{L}\\p{N}_])`, f.key === "domain" ? "giu" : "gu");
    out = out.replace(re, () => {
      counts?.set(f.id, (counts.get(f.id) ?? 0) + 1);
      return f.replacement;
    });
  }
  return out;
}

const byLengthDesc = (a: { text: string }, b: { text: string }) => b.text.length - a.text.length;

// ── HTML (DOMParser, só no cliente) ──────────────────────────────────────────

const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);
const TEXT_ATTRS = ["alt", "title", "aria-label", "placeholder"];
const META_SELECTOR = 'meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]';

type Slot = { get: () => string; set: (v: string) => void };

function textSlots(doc: Document): Slot[] {
  const slots: Slot[] = [];
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && SKIP.has(n.parentElement.tagName)) continue;
    const node = n;
    if (node.nodeValue?.trim()) slots.push({ get: () => node.nodeValue ?? "", set: (v) => (node.nodeValue = v) });
  }
  for (const attr of TEXT_ATTRS) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => slots.push({ get: () => el.getAttribute(attr) ?? "", set: (v) => el.setAttribute(attr, v) }));
  }
  doc.querySelectorAll(META_SELECTOR).forEach((el) => slots.push({ get: () => el.getAttribute("content") ?? "", set: (v) => el.setAttribute("content", v) }));
  return slots;
}

const linkValue = (href: string, scheme: string) => decodeURIComponent(href.slice(scheme.length).split("?")[0]).trim();

export function detectPlaceholders(html: string, sourceUrl?: string): PlaceholderFinding[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const slots = textSlots(doc);
  const texts = slots.map((s) => s.get());
  const hrefs = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
  let sourceHost: string | undefined;
  try {
    sourceHost = sourceUrl ? new URL(sourceUrl).hostname : undefined;
  } catch {
    sourceHost = undefined;
  }
  const candidates = findPlaceholderCandidates(texts, {
    sourceHost,
    mailtos: hrefs.filter((h) => /^mailto:/i.test(h)).map((h) => linkValue(h, "mailto:")),
    tels: hrefs.filter((h) => /^tel:/i.test(h)).map((h) => linkValue(h, "tel:")),
  });

  // Conta com os maiores primeiro, como na troca: "Acme Health" dentro de "Acme Health LLC" não conta duas vezes.
  const findings: PlaceholderFinding[] = candidates
    .map((c) => ({ id: `${c.key}|${c.text}`, key: c.key, text: c.text, replacement: c.replacement ?? `{{${c.key}}}`, count: 0 }))
    .sort(byLengthDesc);
  const counts = new Map<string, number>();
  for (const t of texts) replaceFindings(t, findings, counts);
  for (const h of hrefs) {
    const f = mailtoOrTelFinding(h, findings);
    if (f) counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
  }
  return findings.map((f) => ({ ...f, count: counts.get(f.id) ?? 0 })).filter((f) => f.count > 0);
}

/** O achado de e-mail/telefone que corresponde a um link mailto:/tel: (telefone pelos dígitos). */
function mailtoOrTelFinding(href: string, findings: PlaceholderFinding[]): PlaceholderFinding | undefined {
  if (/^mailto:/i.test(href)) {
    const email = linkValue(href, "mailto:").toLowerCase();
    return findings.find((f) => f.key === "company.email" && f.text.toLowerCase() === email);
  }
  if (/^tel:/i.test(href)) {
    const tel = linkValue(href, "tel:");
    return findings.find((f) => f.key === "company.phone" && samePhone(f.text, tel));
  }
  return undefined;
}

/**
 * Troca os achados escolhidos no HTML. Documento completo sai com o doctype;
 * fragmento sai como fragmento.
 */
export function applyPlaceholderFindings(html: string, chosen: PlaceholderFinding[]): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const findings = [...chosen].sort(byLengthDesc);
  for (const s of textSlots(doc)) {
    const v = s.get();
    const next = replaceFindings(v, findings);
    if (next !== v) s.set(next);
  }
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    const f = mailtoOrTelFinding(href, findings);
    if (!f) return;
    const scheme = /^mailto:/i.test(href) ? "mailto:" : "tel:";
    const query = href.includes("?") ? href.slice(href.indexOf("?")) : "";
    a.setAttribute("href", `${scheme}${f.replacement}${query}`);
  });

  const full = /<html[\s>]/i.test(html) || /<body[\s>]/i.test(html);
  if (!full) return doc.body.innerHTML;
  const doctype = /^\s*<!doctype/i.test(html) ? "<!doctype html>\n" : "";
  return doctype + doc.documentElement.outerHTML;
}
