import { z } from "zod";

/**
 * O contrato de `domain_routes.conditions` — dashboard ⇄ banco ⇄ servidor PHP.
 *
 * O banco só devolve o JSON; quem avalia é o servidor (server/src/conditions.php),
 * e quem garante a forma é este schema, na escrita. Toda chave é opcional e
 * `{}` significa "sempre casa". Chave desconhecida é recusada aqui e tratada
 * como "não casa" pelo servidor.
 *
 *   countries       ISO-3166 alpha-2, maiúsculo. Vem do header CF-IPCountry.
 *   countries_mode  "block" inverte a lista: casa quem NÃO está nela. Ausente = "permitir só".
 *   devices         mobile | tablet | desktop, pelo User-Agent.
 *   languages       ISO 639-1 (duas letras), minúsculo. Vem do Accept-Language do navegador.
 *   languages_mode  igual a countries_mode, para os idiomas.
 *   query           por parâmetro: "present" | "absent" | { equals: "valor" }.
 *   cookies         por cookie (header Cookie): mesma forma de `query`. Serve para
 *                   rotear por etapa do funil (`dop_step`) ou por marcador próprio.
 *   referrer        texto contido no header Referer (case-insensitive).
 *   bot             true = User-Agent de crawler/scraper. SÓ com action=BLOCK
 *                   (CHECK no banco). Serve para barrar, nunca para trocar conteúdo.
 */

export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export type Device = (typeof DEVICES)[number];
export const DEVICE_LABELS: Record<Device, string> = { mobile: "Celular", tablet: "Tablet", desktop: "Desktop" };

/** Sentido de uma lista (país/idioma): permitir só os listados, ou bloquear os listados. */
export const LIST_MODES = ["allow", "block"] as const;
export type ListMode = (typeof LIST_MODES)[number];
export const LIST_MODE_LABELS: Record<ListMode, string> = { allow: "Permitir só", block: "Bloquear" };

export const QUERY_MODES = ["present", "absent", "equals"] as const;
export type QueryMode = (typeof QUERY_MODES)[number];
export const QUERY_MODE_LABELS: Record<QueryMode, string> = { present: "presente", absent: "ausente", equals: "igual a" };

const queryRule = z.union([z.literal("present"), z.literal("absent"), z.strictObject({ equals: z.string().min(1).max(200) })]);
// Nome de cookie: token da RFC 6265 (sem espaço, `;`, `=`, `,`).
const cookieName = z.string().regex(/^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,100}$/, "nome de cookie inválido");

export const conditionsSchema = z
  .strictObject({
    countries: z.array(z.string().regex(/^[A-Z]{2}$/, "país deve ser um código de duas letras")).min(1).max(50).optional(),
    countries_mode: z.literal("block").optional(),
    devices: z.array(z.enum(DEVICES)).min(1).optional(),
    languages: z.array(z.string().regex(/^[a-z]{2}$/, "idioma deve ser um código de duas letras (ISO 639-1)")).min(1).max(50).optional(),
    languages_mode: z.literal("block").optional(),
    query: z.record(z.string().regex(/^[A-Za-z0-9_.\-\[\]]{1,100}$/, "nome de parâmetro inválido"), queryRule).optional(),
    cookies: z.record(cookieName, queryRule).optional(),
    referrer: z.string().min(1).max(200).optional(),
    bot: z.literal(true).optional(),
  })
  // Um modo sem a lista dele não decide nada: recusa aqui para não gravar lixo.
  .refine((c) => !c.countries_mode || (c.countries?.length ?? 0) > 0, { message: "countries_mode exige countries", path: ["countries_mode"] })
  .refine((c) => !c.languages_mode || (c.languages?.length ?? 0) > 0, { message: "languages_mode exige languages", path: ["languages_mode"] });

export type RouteConditions = z.infer<typeof conditionsSchema>;

/** Linha do formulário de regras por nome (parâmetro de URL ou cookie). */
export type RuleRow = { key: string; mode: QueryMode; value: string };
/** @deprecated use RuleRow */
export type QueryRuleRow = RuleRow;

type NamedRule = z.infer<typeof queryRule>;

/** Lê as listas paralelas `<prefix>_key` / `<prefix>_mode` / `<prefix>_value` do formulário. */
function namedRulesFromForm(fd: FormData, prefix: "query" | "cookie"): Record<string, NamedRule> {
  const keys = fd.getAll(`${prefix}_key`).map(String);
  const modes = fd.getAll(`${prefix}_mode`).map(String);
  const values = fd.getAll(`${prefix}_value`).map(String);
  const out: Record<string, NamedRule> = {};
  keys.forEach((key, i) => {
    const k = key.trim();
    if (!k) return;
    const mode = modes[i] ?? "present";
    out[k] = mode === "equals" ? { equals: (values[i] ?? "").trim() } : mode === "absent" ? "absent" : "present";
  });
  return out;
}

function namedRulesToRows(rules: Record<string, NamedRule> | undefined): RuleRow[] {
  return Object.entries(rules ?? {}).map(([key, rule]) =>
    typeof rule === "string" ? { key, mode: rule, value: "" } : { key, mode: "equals", value: rule.equals },
  );
}

/**
 * Lê as condições do FormData do formulário de rota/filtro.
 *
 * Campos: `countries` (texto: "BR, US"), `countries_mode` ("allow"|"block"),
 * `devices` (checkboxes), `languages` (texto: "en, es"), `languages_mode`
 * ("allow"|"block"), `query_key`, `query_mode`, `query_value` e
 * `cookie_key`, `cookie_mode`, `cookie_value` (listas paralelas), `referrer`,
 * `bot` (checkbox). O modo só é gravado quando a lista correspondente existe;
 * "allow" é o padrão e nunca vai para o JSON.
 */
export function parseConditionsForm(fd: FormData): { ok: true; value: RouteConditions } | { ok: false; reason: string } {
  const raw: Record<string, unknown> = {};
  const list = (text: string, upper: boolean) =>
    Array.from(new Set(text.split(/[\s,;]+/).map((c) => (upper ? c.trim().toUpperCase() : c.trim().toLowerCase())).filter(Boolean)));

  const countriesText = String(fd.get("countries") ?? "").trim();
  if (countriesText) {
    raw.countries = list(countriesText, true);
    if (String(fd.get("countries_mode") ?? "allow") === "block") raw.countries_mode = "block";
  }

  const devices = fd.getAll("devices").map(String).filter(Boolean);
  if (devices.length > 0) raw.devices = Array.from(new Set(devices));

  const languagesText = String(fd.get("languages") ?? "").trim();
  if (languagesText) {
    raw.languages = list(languagesText, false);
    if (String(fd.get("languages_mode") ?? "allow") === "block") raw.languages_mode = "block";
  }

  const query = namedRulesFromForm(fd, "query");
  if (Object.keys(query).length > 0) raw.query = query;

  const cookies = namedRulesFromForm(fd, "cookie");
  if (Object.keys(cookies).length > 0) raw.cookies = cookies;

  const referrer = String(fd.get("referrer") ?? "").trim();
  if (referrer) raw.referrer = referrer;

  if (fd.get("bot") === "on" || fd.get("bot") === "true") raw.bot = true;

  const parsed = conditionsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `Condições inválidas: ${issue.path.join(".") || "?"}: ${issue.message}` };
  }
  return { ok: true, value: parsed.data };
}

/** Converte as condições gravadas para as linhas do formulário. */
export function conditionsToForm(c: RouteConditions | null | undefined): {
  countries: string;
  countriesMode: ListMode;
  devices: Device[];
  languages: string;
  languagesMode: ListMode;
  query: RuleRow[];
  cookies: RuleRow[];
  referrer: string;
  bot: boolean;
} {
  return {
    countries: (c?.countries ?? []).join(", "),
    countriesMode: c?.countries_mode === "block" ? "block" : "allow",
    devices: [...(c?.devices ?? [])],
    languages: (c?.languages ?? []).join(", "),
    languagesMode: c?.languages_mode === "block" ? "block" : "allow",
    query: namedRulesToRows(c?.query),
    cookies: namedRulesToRows(c?.cookies),
    referrer: c?.referrer ?? "",
    bot: c?.bot === true,
  };
}

/** Resumo curto para a tabela de rotas. */
export function summarizeConditions(c: RouteConditions | null | undefined): string {
  if (!c) return "Sempre";
  const parts: string[] = [];
  if (c.countries?.length) parts.push(`País${c.countries_mode === "block" ? " (bloquear)" : ""}: ${c.countries.join(", ")}`);
  if (c.devices?.length) parts.push(`Dispositivo: ${c.devices.map((d) => DEVICE_LABELS[d]).join(", ")}`);
  if (c.languages?.length) parts.push(`Idioma${c.languages_mode === "block" ? " (bloquear)" : ""}: ${c.languages.join(", ")}`);
  for (const [key, rule] of Object.entries(c.query ?? {})) {
    parts.push(typeof rule === "string" ? `?${key} ${QUERY_MODE_LABELS[rule]}` : `?${key} = ${rule.equals}`);
  }
  for (const [key, rule] of Object.entries(c.cookies ?? {})) {
    parts.push(typeof rule === "string" ? `cookie ${key} ${QUERY_MODE_LABELS[rule]}` : `cookie ${key} = ${rule.equals}`);
  }
  if (c.referrer) parts.push(`Referrer contém "${c.referrer}"`);
  if (c.bot) parts.push("Só bots/crawlers");
  return parts.length ? parts.join(" · ") : "Sempre";
}
