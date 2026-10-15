import { APP_TZ, localDateKey } from "@/lib/time-zone";
import { companyName } from "./company-name";
import { PRODUCT_KIT_FIELDS, PRODUCT_KIT_FIELD_LABELS, type ProductKitField } from "./product-values";

/**
 * {{key}} placeholders in pages, replaced with the domain's and the visit's data.
 *
 * The real replacement is done by the delivery server, when serving
 * (server/src/placeholders.php). This module is the list of fields the dashboard
 * offers and the same replacement for the editor preview. The rules and tables
 * (languages, months) are the same on both sides — change one, change the other:
 *
 * - only `{{key}}` with a known key (spaces inside are fine: `{{ company.phone }}`);
 *   `{{ any.other }}` stays as is — a page using Vue or Alpine isn't affected;
 * - an empty field becomes empty text;
 * - the value goes in HTML-escaped.
 *
 * `company.*` lives in pages.domains.placeholders (jsonb, dotted keys);
 * `company.name` isn't stored: it's the legal name (`company.llc`) without the
 * legal suffix (company-name.ts). The automatic ones come from the visit: `url` and
 * `slug` from the served path, `lang`, `language` and the language of `date` from
 * the visitor's Accept-Language (without it, English), `date` and `year` from the
 * day in New York. A vendor page also has `checkout.<key>`: its product's checkout
 * links on its platform (checkout-links.ts), and `product.name` /
 * `product.kit<N>.<field>`: its product's bundles (product-values.ts) — both
 * merged by pages.resolve; the editor offers them when the page has them.
 */

export const PLACEHOLDER_FIELDS = [
  { key: "company.llc", label: "Legal name", example: "Acme Health LLC", max: 150 },
  { key: "company.number", label: "Registration number (EIN, CNPJ…), number only", example: "12-3456789", max: 60 },
  { key: "company.address", label: "Address", example: "123 Main St, Austin, TX 78701", max: 250 },
  { key: "company.phone", label: "Phone", example: "(555) 123-4567", max: 40 },
  { key: "company.email", label: "Email", example: "contact@example.com", max: 150 },
] as const;

export type PlaceholderKey = (typeof PLACEHOLDER_FIELDS)[number]["key"];

/** Filled in automatically: the company name (from the legal name) and the visit's. */
export const AUTO_PLACEHOLDERS = [
  { key: "company.name", label: "Company name", note: "the legal name without LLC, LTDA, Inc…" },
  { key: "url", label: "Page URL", note: "https://domain.com/path, no query parameters" },
  { key: "domain", label: "Domain", note: "without www." },
  { key: "slug", label: "Page path", note: "e.g. / or /presell" },
  { key: "date", label: "Today's date", note: "written out, in the visitor's language" },
  { key: "year", label: "Current year", note: "e.g. © {{year}}" },
  { key: "lang", label: "Visitor's language", note: "code: en, pt, es…" },
  { key: "language", label: "Language name", note: "English, Português, Español…" },
  // Filled by the funnel's VSL split (server/src/vsl.php), not with the domain's data: funnel pages only.
  { key: "video_id", label: "VSL video (funnel)", note: "the VTurb video drawn for the visitor from the funnel's VSLs tab" },
  // The funnel page the gate served (server/src/beacon.php, the page_id cookie's id): funnel pages only.
  { key: "page_id", label: "Funnel page id", note: "the page the funnel's split served, e.g. dot.js?page_id={{page_id}}" },
] as const;

/** Each language's name in that language. No entry: the code itself. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", pt: "Português", es: "Español", fr: "Français", de: "Deutsch", it: "Italiano", nl: "Nederlands",
  pl: "Polski", ru: "Русский", uk: "Українська", tr: "Türkçe", sv: "Svenska", da: "Dansk", no: "Norsk", nb: "Norsk",
  fi: "Suomi", cs: "Čeština", ro: "Română", hu: "Magyar", el: "Ελληνικά", he: "עברית", ar: "العربية", hi: "हिन्दी",
  ja: "日本語", zh: "中文", ko: "한국어", id: "Bahasa Indonesia", ms: "Bahasa Melayu", vi: "Tiếng Việt", th: "ไทย", tl: "Filipino",
};

/** Months and format of the written-out date. A language without an entry uses English. */
const DATE_FORMATS: Record<string, { months: string[]; format: (d: number, month: string, y: number) => string }> = {
  en: {
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    format: (d, m, y) => `${m} ${d}, ${y}`,
  },
  pt: {
    months: ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
    format: (d, m, y) => `${d} de ${m} de ${y}`,
  },
  es: {
    months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    format: (d, m, y) => `${d} de ${m} de ${y}`,
  },
  fr: {
    months: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    format: (d, m, y) => `${d} ${m} ${y}`,
  },
  de: {
    months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
    format: (d, m, y) => `${d}. ${m} ${y}`,
  },
  it: {
    months: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
    format: (d, m, y) => `${d} ${m} ${y}`,
  },
  nl: {
    months: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"],
    format: (d, m, y) => `${d} ${m} ${y}`,
  },
};

export const placeholderToken = (key: string) => `{{${key}}}`;

// ── Editor autocomplete: typing "{{" opens the placeholder list ─────────────
export type PlaceholderOption = { key: string; label: string; hint: string };

/** Every placeholder, in menu order: company fields, then the automatic ones. */
export const PLACEHOLDER_OPTIONS: PlaceholderOption[] = [
  ...PLACEHOLDER_FIELDS.map((f) => ({ key: f.key, label: f.label, hint: f.example })),
  ...AUTO_PLACEHOLDERS.map((f) => ({ key: f.key, label: f.label, hint: f.note })),
];

/** A page's own placeholders (not in PLACEHOLDER_OPTIONS) the editor also offers: a vendor page's product, checkout and upsell values. */
const PAGE_KEY_RE = /^(?:product|checkout|upsell)\./;

function pageOptionLabel(key: string): string {
  if (key === "product.name") return "Product name";
  const kit = /^product\.kit(\d+)\.(\w+)$/.exec(key);
  if (kit) return `Kit ${kit[1]} · ${PRODUCT_KIT_FIELD_LABELS[kit[2] as ProductKitField] ?? kit[2]}`;
  if (key.startsWith("checkout.")) return `Checkout ${key.slice(9)}`;
  if (key === "upsell.offer") return "Upsell offer";
  return `Upsell ${key.slice(7)}`;
}

/** Product first (name, then each kit's fields in order), then checkout, then upsell. */
function pageOptionRank(key: string): [number, number, number, string] {
  if (key === "product.name") return [0, 0, 0, key];
  const kit = /^product\.kit(\d+)\.(\w+)$/.exec(key);
  if (kit) return [1, Number(kit[1]), PRODUCT_KIT_FIELDS.indexOf(kit[2] as ProductKitField), key];
  return [key.startsWith("checkout.") ? 2 : 3, 0, 0, key];
}

/**
 * Every placeholder the editor offers for a page: PLACEHOLDER_OPTIONS, then the
 * page's own values among `values` (a vendor page's {{product.kit6.price}},
 * {{checkout.up1}}…; null = none), with their value as the hint.
 */
export function placeholderOptions(values?: Record<string, string> | null): PlaceholderOption[] {
  if (!values) return PLACEHOLDER_OPTIONS;
  const own = Object.keys(values)
    .filter((k) => PAGE_KEY_RE.test(k))
    .sort((a, b) => {
      const [x, y] = [pageOptionRank(a), pageOptionRank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3].localeCompare(y[3]);
    })
    .map((key) => ({ key, label: pageOptionLabel(key), hint: values[key] || "(empty)" }));
  return own.length ? [...PLACEHOLDER_OPTIONS, ...own] : PLACEHOLDER_OPTIONS;
}

/** If the text before the cursor ends in an open "{{", where it starts and how much of the key was typed. */
export function openPlaceholderAt(before: string): { from: number; query: string } | null {
  const m = /\{\{\s*([a-z0-9_.]*)$/i.exec(before);
  return m ? { from: m.index, query: m[1].toLowerCase() } : null;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The options for what was typed: key (or the part after the dot) starting with it; then key or name
 * containing it. `values` adds the page's own placeholders (placeholderOptions).
 */
export function suggestPlaceholders(query: string, values?: Record<string, string> | null): PlaceholderOption[] {
  const options = placeholderOptions(values);
  const q = fold(query);
  if (!q) return options;
  const starts = options.filter((o) => o.key.startsWith(q) || o.key.slice(o.key.lastIndexOf(".") + 1).startsWith(q));
  const contains = options.filter((o) => !starts.includes(o) && (o.key.includes(q) || fold(o.label).includes(q)));
  return [...starts, ...contains];
}

/**
 * Replaces the open "{{…" (from `from` to the cursor) with the full placeholder. A "}"
 * or "}}" right after the cursor (auto-closing) is absorbed.
 */
export function insertPlaceholder(text: string, from: number, caret: number, key: string): { text: string; caret: number } {
  const token = placeholderToken(key);
  const rest = text.slice(caret);
  const after = rest.startsWith("}}") ? rest.slice(2) : rest.startsWith("}") ? rest.slice(1) : rest;
  return { text: text.slice(0, from) + token + after, caret: from + token.length };
}

const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*\}\}/g;

/** An object with every company field, empty: what a new domain saves. */
export function emptyPlaceholders(): Record<PlaceholderKey, string> {
  return Object.fromEntries(PLACEHOLDER_FIELDS.map((f) => [f.key, ""])) as Record<PlaceholderKey, string>;
}

/** "September 23, 2026" / "23 de setembro de 2026"… from "YYYY-MM-DD". */
export function longDate(isoDate: string, lang: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const f = DATE_FORMATS[lang] ?? DATE_FORMATS.en;
  return f.format(d, f.months[m - 1], y);
}

/**
 * A visit's values: the ones saved on the domain (text only), a vendor page's
 * `checkout.<key>` and `product.*` (vendorPlaceholderValues) + the automatic
 * ones. `path` is the served path; `lang` the visitor's language (the preview uses "en").
 */
export function placeholderValues(opts: {
  domain: string;
  stored: unknown;
  vendor?: Record<string, string>;
  path: string;
  lang?: string;
  now?: Date;
}): Record<string, string> {
  const values: Record<string, string> = {};
  const { stored } = opts;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored)) {
      if (typeof v === "string") values[k] = v;
    }
  }
  Object.assign(values, opts.vendor);
  values["company.name"] = companyName(values["company.llc"] ?? "");
  const lang = opts.lang || "en";
  const today = localDateKey((opts.now ?? new Date()).getTime(), APP_TZ);
  values.domain = opts.domain;
  values.url = `https://${opts.domain}${opts.path}`;
  values.slug = opts.path;
  values.lang = lang;
  values.language = LANGUAGE_NAMES[lang] ?? lang;
  values.date = longDate(today, lang);
  values.year = today.slice(0, 4);
  return values;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** Replaces the known placeholders with their values (HTML-escaped). */
export function applyPlaceholders(html: string, values: Record<string, string>): string {
  return html.replace(TOKEN_RE, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? escapeHtml(values[key]) : token,
  );
}

/** Placeholder keys used in the HTML (known or not), in order of appearance. */
export function placeholdersIn(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(TOKEN_RE), (m) => m[1]))];
}
