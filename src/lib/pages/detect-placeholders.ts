import { SUFFIXES_ANY_CASE, SUFFIXES_EXACT, companyName } from "./company-name";

/**
 * "Create template" from a link or pasted HTML: finds text in the content that
 * looks like company data (plus the copyright year and the source domain) and
 * suggests replacing it with {{...}} placeholders. The user confirms each one
 * first — detection is by text pattern and gets things wrong; nothing is
 * replaced without a "yes".
 *
 * Looks only in visible text, in alt/title/aria-label/placeholder and in the
 * description/og/twitter metas; email and phone also in mailto: and tel:
 * links. Never inside <script>/<style> nor in other attributes (class,
 * src, plain href).
 *
 * `findPlaceholderCandidates` is pure (list of texts → findings); reading and
 * rewriting the HTML (DOMParser) live in `detectPlaceholders` /
 * `applyPlaceholderFindings`, client-only.
 */

export type PlaceholderFinding = {
  /** Stable row key (kind + text). */
  id: string;
  /** The placeholder that goes in (e.g. "company.email"). */
  key: string;
  /** The text found. */
  text: string;
  /** What takes its place (almost always `{{key}}`; for the copyright, "© {{year}}"). */
  replacement: string;
  /** How many times it appears (after the longer findings have been replaced). */
  count: number;
};

// ── Patterns ─────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Suffixes for FINDING a legal name: as they're actually written (and in
 * uppercase), with an optional dot. "Company" is left out: "About Our
 * Company" isn't a legal name.
 */
const DETECT_SUFFIXES = [
  ...new Set([
    ...SUFFIXES_ANY_CASE.filter((s) => s !== "Company").flatMap((s) => [s, s.toUpperCase()]),
    ...SUFFIXES_EXACT,
  ]),
].sort((a, b) => b.length - a.length);
const SUFFIX = `(?:${DETECT_SUFFIXES.map(escapeRe).join("|")})\\.?(?![\\p{L}\\p{N}])`;

// Name word: starts with an uppercase letter or a digit and has a letter; lowercase connectors between words.
const CAP_WORD = String.raw`(?!${SUFFIX})(?=[\p{L}\p{N}&'’.\-]*\p{L})[\p{Lu}\p{N}][\p{L}\p{N}&'’.\-]*`;
const JOINER = String.raw`(?:&|of|and|the|de|da|do|dos|das|del|e|y)`;
const LEGAL_RE = new RegExp(
  `${CAP_WORD}(?:\\s+(?:${CAP_WORD}|${JOINER})){0,6}(?:(?:,?\\s+|\\s*[-–—&]\\s*)${SUFFIX}){1,3}`,
  "gu",
);
/** Words that open a sentence, not a name ("Copyright Acme LLC" → "Acme LLC"). */
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

// ── Find (pure) ──────────────────────────────────────────────────────────────

type Candidate = { key: string; text: string; replacement?: string };

function cleanLegal(match: string): string | null {
  const words = match.trim().split(/\s+/);
  while (words.length > 1 && LEADING_NOISE.has(words[0].toLowerCase())) words.shift();
  // Without the trailing dot: it almost always belongs to the sentence ("… LLC. All rights reserved"), and the page keeps it.
  const legal = words.join(" ").replace(/^[&,\-–—\s]+/, "").replace(/\.$/, "");
  if (legal.length < 4 || legal.length > 90) return null;
  const name = companyName(legal);
  return name !== legal && /\p{L}{2,}/u.test(name) ? legal : null;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Same phone with or without the country code ("+1 555…" and "(555)…"). */
function samePhone(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  return da === db || (Math.min(da.length, db.length) >= 10 && (da.endsWith(db) || db.endsWith(da)));
}

function phoneLike(s: string): boolean {
  const n = digits(s).length;
  // 10 to 15 digits and some phone sign (+, parentheses or a separator): rules out dates, prices and ids.
  return n >= 10 && n <= 15 && /[+()\s.-]/.test(s) && !/^\d{4}[-./]\d{2}[-./]\d{2}/.test(s);
}

/**
 * Placeholder candidates in the texts. `sourceHost` (link) turns the source
 * domain into {{domain}}.
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
  // Phones after the registration number: a CNPJ must not become a phone.
  const numbers = [...out.values()].filter((c) => c.key === "company.number").map((c) => digits(c.text));
  for (const t of texts) {
    for (const m of t.matchAll(PHONE_RE)) {
      if (phoneLike(m[0]) && !numbers.includes(digits(m[0]))) add({ key: "company.phone", text: m[0] });
    }
  }
  for (const e of opts.mailtos ?? []) add({ key: "company.email", text: e });
  // A tel: without the same phone visible on the page becomes its own finding.
  const phones = [...out.values()].filter((c) => c.key === "company.phone").map((c) => c.text);
  for (const p of opts.tels ?? []) if (phoneLike(p) && !phones.some((v) => samePhone(v, p))) add({ key: "company.phone", text: p });

  const host = opts.sourceHost?.replace(/^www\./i, "").toLowerCase();
  if (host && texts.some((t) => t.toLowerCase().includes(host))) add({ key: "domain", text: host });

  return [...out.values()];
}

// ── Count and replace ────────────────────────────────────────────────────────

/** Replaces each finding in a text (longest to shortest), respecting word boundaries. */
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

// ── HTML (DOMParser, client-only) ────────────────────────────────────────────

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

  // Counts the longest first, as in the replacement: "Acme Health" inside "Acme Health LLC" doesn't count twice.
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

/** The email/phone finding that matches a mailto:/tel: link (phone by its digits). */
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
 * Replaces the chosen findings in the HTML. A complete document comes out with
 * the doctype; a fragment comes out as a fragment.
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
