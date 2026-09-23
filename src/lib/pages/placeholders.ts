/**
 * Marcadores {{chave}} nas páginas, trocados pelos dados do domínio.
 *
 * Quem troca de verdade é o servidor de entrega, na hora de servir
 * (server/src/placeholders.php). Este módulo é a lista de campos que o painel
 * oferece e a mesma troca para o preview do editor. As regras são as mesmas
 * nos dois lados:
 *
 * - só `{{chave}}` com chave conhecida (espaços dentro das chaves valem:
 *   `{{ phone }}`); `{{ qualquer_outra }}` fica como está — página com Vue ou
 *   Alpine não é afetada;
 * - campo vazio vira texto vazio (nunca aparece `{{phone}}` cru para o
 *   visitante de um domínio cujos dados já foram salvos);
 * - o valor entra escapado para HTML.
 *
 * Os valores ficam em pages.domains.placeholders (jsonb). `domain` e `year`
 * são automáticos. Campo novo aqui: domínios antigos não têm a chave até
 * salvarem os dados de novo, e o marcador fica cru neles até lá.
 */

export const PLACEHOLDER_FIELDS = [
  { key: "company_name", label: "Nome da empresa", example: "Acme Health LLC", max: 150 },
  { key: "phone", label: "Telefone", example: "(555) 123-4567", max: 40 },
  { key: "email", label: "E-mail", example: "contact@example.com", max: 150 },
  { key: "address", label: "Endereço", example: "123 Main St, Suite 400", max: 200 },
  { key: "city", label: "Cidade", example: "Austin", max: 100 },
  { key: "state", label: "Estado", example: "TX", max: 100 },
  { key: "zip_code", label: "CEP / ZIP", example: "78701", max: 20 },
  { key: "country", label: "País", example: "United States", max: 100 },
] as const;

export type PlaceholderKey = (typeof PLACEHOLDER_FIELDS)[number]["key"];

/** Preenchidos sozinhos: o domínio (sem www.) e o ano corrente (UTC). */
export const AUTO_PLACEHOLDERS = [
  { key: "domain", label: "Domínio", note: "o domínio, sem www." },
  { key: "year", label: "Ano atual", note: "ex.: © {{year}}" },
] as const;

export const placeholderToken = (key: string) => `{{${key}}}`;

const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** Um objeto com todos os campos, vazios: o que um domínio novo grava. */
export function emptyPlaceholders(): Record<PlaceholderKey, string> {
  return Object.fromEntries(PLACEHOLDER_FIELDS.map((f) => [f.key, ""])) as Record<PlaceholderKey, string>;
}

/** Valores de um domínio para a troca: os salvos (só texto) + domain + year. */
export function domainPlaceholderValues(domain: string, stored: unknown, now: Date = new Date()): Record<string, string> {
  const values: Record<string, string> = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored)) {
      if (typeof v === "string") values[k] = v;
    }
  }
  values.domain = domain;
  values.year = String(now.getUTCFullYear());
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
