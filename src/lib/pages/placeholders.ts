import { APP_TZ, localDateKey } from "@/lib/time-zone";
import { companyName } from "./company-name";

/**
 * Marcadores {{chave}} nas páginas, trocados pelos dados do domínio e da visita.
 *
 * Quem troca de verdade é o servidor de entrega, na hora de servir
 * (server/src/placeholders.php). Este módulo é a lista de campos que o painel
 * oferece e a mesma troca para o preview do editor. As regras e as tabelas
 * (idiomas, meses) são as mesmas nos dois lados — mudou uma, mude a outra:
 *
 * - só `{{chave}}` com chave conhecida (espaços dentro valem: `{{ company.phone }}`);
 *   `{{ qualquer.outra }}` fica como está — página com Vue ou Alpine não é afetada;
 * - campo vazio vira texto vazio;
 * - o valor entra escapado para HTML.
 *
 * `company.*` fica em pages.domains.placeholders (jsonb, chaves com ponto);
 * `company.name` não é guardado: é a razão social (`company.llc`) sem o
 * sufixo jurídico (company-name.ts). Os automáticos saem da visita: `url` e
 * `slug` do path servido, `lang`, `language` e o idioma de `date` do
 * Accept-Language do visitante (sem ele, inglês), `date` e `year` do dia em
 * Nova York.
 */

export const PLACEHOLDER_FIELDS = [
  { key: "company.llc", label: "Razão social", example: "Acme Health LLC", max: 150 },
  { key: "company.number", label: "Número de registro (EIN, CNPJ…), só o número", example: "12-3456789", max: 60 },
  { key: "company.address", label: "Endereço", example: "123 Main St, Austin, TX 78701", max: 250 },
  { key: "company.phone", label: "Telefone", example: "(555) 123-4567", max: 40 },
  { key: "company.email", label: "E-mail", example: "contact@example.com", max: 150 },
] as const;

export type PlaceholderKey = (typeof PLACEHOLDER_FIELDS)[number]["key"];

/** Preenchidos sozinhos: o nome da empresa (da razão social) e os da visita. */
export const AUTO_PLACEHOLDERS = [
  { key: "company.name", label: "Nome da empresa", note: "a razão social sem LLC, LTDA, Inc…" },
  { key: "url", label: "Endereço da página", note: "https://dominio.com/caminho, sem parâmetros" },
  { key: "domain", label: "Domínio", note: "sem www." },
  { key: "slug", label: "Caminho da página", note: "ex.: / ou /pressel" },
  { key: "date", label: "Data de hoje", note: "por extenso, no idioma do visitante" },
  { key: "year", label: "Ano atual", note: "ex.: © {{year}}" },
  { key: "lang", label: "Idioma do visitante", note: "código: en, pt, es…" },
  { key: "language", label: "Nome do idioma", note: "English, Português, Español…" },
] as const;

/** Nome de cada idioma nele mesmo. Sem entrada: o próprio código. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", pt: "Português", es: "Español", fr: "Français", de: "Deutsch", it: "Italiano", nl: "Nederlands",
  pl: "Polski", ru: "Русский", uk: "Українська", tr: "Türkçe", sv: "Svenska", da: "Dansk", no: "Norsk", nb: "Norsk",
  fi: "Suomi", cs: "Čeština", ro: "Română", hu: "Magyar", el: "Ελληνικά", he: "עברית", ar: "العربية", hi: "हिन्दी",
  ja: "日本語", zh: "中文", ko: "한국어", id: "Bahasa Indonesia", ms: "Bahasa Melayu", vi: "Tiếng Việt", th: "ไทย", tl: "Filipino",
};

/** Meses e formato da data por extenso. Idioma sem entrada usa o inglês. */
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

// ── Autocompletar no editor: escrever "{{" abre a lista dos marcadores ──────
export type PlaceholderOption = { key: string; label: string; hint: string };

/** Todos os marcadores, na ordem do menu: campos da empresa, depois os automáticos. */
export const PLACEHOLDER_OPTIONS: PlaceholderOption[] = [
  ...PLACEHOLDER_FIELDS.map((f) => ({ key: f.key, label: f.label, hint: f.example })),
  ...AUTO_PLACEHOLDERS.map((f) => ({ key: f.key, label: f.label, hint: f.note })),
];

/** Se o texto antes do cursor termina num "{{" aberto, onde ele começa e o que já foi digitado da chave. */
export function openPlaceholderAt(before: string): { from: number; query: string } | null {
  const m = /\{\{\s*([a-z0-9_.]*)$/i.exec(before);
  return m ? { from: m.index, query: m[1].toLowerCase() } : null;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** As opções para o que foi digitado: chave (ou a parte depois do ponto) começando com ele; depois chave ou nome contendo. */
export function suggestPlaceholders(query: string): PlaceholderOption[] {
  const q = fold(query);
  if (!q) return PLACEHOLDER_OPTIONS;
  const starts = PLACEHOLDER_OPTIONS.filter((o) => o.key.startsWith(q) || o.key.slice(o.key.lastIndexOf(".") + 1).startsWith(q));
  const contains = PLACEHOLDER_OPTIONS.filter((o) => !starts.includes(o) && (o.key.includes(q) || fold(o.label).includes(q)));
  return [...starts, ...contains];
}

/**
 * Troca o "{{…" aberto (de `from` até o cursor) pelo marcador completo. Um "}"
 * ou "}}" logo depois do cursor (fechamento automático) é absorvido.
 */
export function insertPlaceholder(text: string, from: number, caret: number, key: string): { text: string; caret: number } {
  const token = placeholderToken(key);
  const rest = text.slice(caret);
  const after = rest.startsWith("}}") ? rest.slice(2) : rest.startsWith("}") ? rest.slice(1) : rest;
  return { text: text.slice(0, from) + token + after, caret: from + token.length };
}

const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*\}\}/g;

/** Um objeto com todos os campos da empresa, vazios: o que um domínio novo grava. */
export function emptyPlaceholders(): Record<PlaceholderKey, string> {
  return Object.fromEntries(PLACEHOLDER_FIELDS.map((f) => [f.key, ""])) as Record<PlaceholderKey, string>;
}

/** "September 23, 2026" / "23 de setembro de 2026"… a partir de "YYYY-MM-DD". */
export function longDate(isoDate: string, lang: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const f = DATE_FORMATS[lang] ?? DATE_FORMATS.en;
  return f.format(d, f.months[m - 1], y);
}

/**
 * Os valores de uma visita: os salvos no domínio (só texto) + os automáticos.
 * `path` é o path servido; `lang` o idioma do visitante (o preview usa "en").
 */
export function placeholderValues(opts: { domain: string; stored: unknown; path: string; lang?: string; now?: Date }): Record<string, string> {
  const values: Record<string, string> = {};
  const { stored } = opts;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored)) {
      if (typeof v === "string") values[k] = v;
    }
  }
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

/** Troca os marcadores conhecidos pelos valores (escapados para HTML). */
export function applyPlaceholders(html: string, values: Record<string, string>): string {
  return html.replace(TOKEN_RE, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? escapeHtml(values[key]) : token,
  );
}

/** Chaves de marcadores usadas no HTML (conhecidas ou não), na ordem em que aparecem. */
export function placeholdersIn(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(TOKEN_RE), (m) => m[1]))];
}
