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
 *   referrer        texto contido no header Referer (case-insensitive).
 *   bot             true = User-Agent de crawler/scraper. SÓ com action=BLOCK
 *                   (CHECK no banco). Serve para barrar, nunca para trocar conteúdo.
 */

export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export type Device = (typeof DEVICES)[number];
export const DEVICE_LABELS: Record<Device, string> = { mobile: "Mobile", tablet: "Tablet", desktop: "Desktop" };

/** Sentido de uma lista (país/idioma): permitir só os listados, ou bloquear os listados. */
export const LIST_MODES = ["allow", "block"] as const;
export type ListMode = (typeof LIST_MODES)[number];
export const LIST_MODE_LABELS: Record<ListMode, string> = { allow: "Allow only", block: "Block" };

export const QUERY_MODES = ["present", "absent", "equals"] as const;
export type QueryMode = (typeof QUERY_MODES)[number];
export const QUERY_MODE_LABELS: Record<QueryMode, string> = { present: "present", absent: "absent", equals: "equals" };

const queryRule = z.union([z.literal("present"), z.literal("absent"), z.strictObject({ equals: z.string().min(1).max(200) })]);

export const conditionsSchema = z
  .strictObject({
    countries: z.array(z.string().regex(/^[A-Z]{2}$/, "country must be a two-letter code")).min(1).max(50).optional(),
    countries_mode: z.literal("block").optional(),
    devices: z.array(z.enum(DEVICES)).min(1).optional(),
    languages: z.array(z.string().regex(/^[a-z]{2}$/, "language must be a two-letter code (ISO 639-1)")).min(1).max(50).optional(),
    languages_mode: z.literal("block").optional(),
    query: z.record(z.string().regex(/^[A-Za-z0-9_.\-\[\]]{1,100}$/, "invalid parameter name"), queryRule).optional(),
    referrer: z.string().min(1).max(200).optional(),
    bot: z.literal(true).optional(),
  })
  // Um modo sem a lista dele não decide nada: recusa aqui para não gravar lixo.
  .refine((c) => !c.countries_mode || (c.countries?.length ?? 0) > 0, { message: "countries_mode requires countries", path: ["countries_mode"] })
  .refine((c) => !c.languages_mode || (c.languages?.length ?? 0) > 0, { message: "languages_mode requires languages", path: ["languages_mode"] });

export type RouteConditions = z.infer<typeof conditionsSchema>;

/** Linha do formulário de parâmetros. */
export type QueryRuleRow = { key: string; mode: QueryMode; value: string };

/**
 * Lê as condições do FormData do formulário de rota/filtro.
 *
 * Campos: `countries` (texto: "BR, US"), `countries_mode` ("allow"|"block"),
 * `devices` (checkboxes), `languages` (texto: "en, es"), `languages_mode`
 * ("allow"|"block"), `query_key`, `query_mode`, `query_value` (listas
 * paralelas), `referrer`, `bot` (checkbox). O modo só é gravado quando a lista
 * correspondente existe; "allow" é o padrão e nunca vai para o JSON.
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

  const keys = fd.getAll("query_key").map(String);
  const modes = fd.getAll("query_mode").map(String);
  const values = fd.getAll("query_value").map(String);
  const query: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    const k = key.trim();
    if (!k) return;
    const mode = modes[i] ?? "present";
    query[k] = mode === "equals" ? { equals: (values[i] ?? "").trim() } : mode;
  });
  if (Object.keys(query).length > 0) raw.query = query;

  const referrer = String(fd.get("referrer") ?? "").trim();
  if (referrer) raw.referrer = referrer;

  if (fd.get("bot") === "on" || fd.get("bot") === "true") raw.bot = true;

  const parsed = conditionsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `Invalid conditions: ${issue.path.join(".") || "?"}: ${issue.message}` };
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
  query: QueryRuleRow[];
  referrer: string;
  bot: boolean;
} {
  const query: QueryRuleRow[] = Object.entries(c?.query ?? {}).map(([key, rule]) =>
    typeof rule === "string" ? { key, mode: rule, value: "" } : { key, mode: "equals", value: rule.equals },
  );
  return {
    countries: (c?.countries ?? []).join(", "),
    countriesMode: c?.countries_mode === "block" ? "block" : "allow",
    devices: [...(c?.devices ?? [])],
    languages: (c?.languages ?? []).join(", "),
    languagesMode: c?.languages_mode === "block" ? "block" : "allow",
    query,
    referrer: c?.referrer ?? "",
    bot: c?.bot === true,
  };
}

/** Resumo curto para a tabela de rotas. */
export function summarizeConditions(c: RouteConditions | null | undefined): string {
  if (!c) return "Always";
  const parts: string[] = [];
  if (c.countries?.length) parts.push(`Country${c.countries_mode === "block" ? " (block)" : ""}: ${c.countries.join(", ")}`);
  if (c.devices?.length) parts.push(`Device: ${c.devices.map((d) => DEVICE_LABELS[d]).join(", ")}`);
  if (c.languages?.length) parts.push(`Language${c.languages_mode === "block" ? " (block)" : ""}: ${c.languages.join(", ")}`);
  for (const [key, rule] of Object.entries(c.query ?? {})) {
    parts.push(typeof rule === "string" ? `?${key} ${QUERY_MODE_LABELS[rule]}` : `?${key} = ${rule.equals}`);
  }
  if (c.referrer) parts.push(`Referrer contains "${c.referrer}"`);
  if (c.bot) parts.push("Bots/crawlers only");
  return parts.length ? parts.join(" · ") : "Always";
}
