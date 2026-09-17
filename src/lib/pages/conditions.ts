import { z } from "zod";

/**
 * O contrato de `domain_routes.conditions` — dashboard ⇄ banco ⇄ servidor PHP.
 *
 * O banco só devolve o JSON; quem avalia é o servidor (server/src/conditions.php),
 * e quem garante a forma é este schema, na escrita. Toda chave é opcional e
 * `{}` significa "sempre casa". Chave desconhecida é recusada aqui e tratada
 * como "não casa" pelo servidor.
 *
 *   countries  ISO-3166 alpha-2, maiúsculo. Vem do header CF-IPCountry.
 *   devices    mobile | tablet | desktop, pelo User-Agent.
 *   query      por parâmetro: "present" | "absent" | { equals: "valor" }.
 *   referrer   texto contido no header Referer (case-insensitive).
 *   bot        true = User-Agent de crawler/scraper. SÓ com action=BLOCK
 *              (CHECK no banco). Serve para barrar, nunca para trocar conteúdo.
 */

export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export type Device = (typeof DEVICES)[number];
export const DEVICE_LABELS: Record<Device, string> = { mobile: "Celular", tablet: "Tablet", desktop: "Desktop" };

export const QUERY_MODES = ["present", "absent", "equals"] as const;
export type QueryMode = (typeof QUERY_MODES)[number];
export const QUERY_MODE_LABELS: Record<QueryMode, string> = { present: "presente", absent: "ausente", equals: "igual a" };

const queryRule = z.union([z.literal("present"), z.literal("absent"), z.strictObject({ equals: z.string().min(1).max(200) })]);

export const conditionsSchema = z.strictObject({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/, "país deve ser um código de duas letras")).min(1).max(50).optional(),
  devices: z.array(z.enum(DEVICES)).min(1).optional(),
  query: z.record(z.string().regex(/^[A-Za-z0-9_.\-\[\]]{1,100}$/, "nome de parâmetro inválido"), queryRule).optional(),
  referrer: z.string().min(1).max(200).optional(),
  bot: z.literal(true).optional(),
});

export type RouteConditions = z.infer<typeof conditionsSchema>;

/** Linha do formulário de parâmetros. */
export type QueryRuleRow = { key: string; mode: QueryMode; value: string };

/**
 * Lê as condições do FormData do formulário de rota.
 *
 * Campos: `countries` (texto: "BR, US"), `devices` (checkboxes), `query_key`,
 * `query_mode`, `query_value` (listas paralelas), `referrer`, `bot` (checkbox).
 */
export function parseConditionsForm(fd: FormData): { ok: true; value: RouteConditions } | { ok: false; reason: string } {
  const raw: Record<string, unknown> = {};

  const countriesText = String(fd.get("countries") ?? "").trim();
  if (countriesText) {
    raw.countries = Array.from(
      new Set(
        countriesText
          .split(/[\s,;]+/)
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean),
      ),
    );
  }

  const devices = fd.getAll("devices").map(String).filter(Boolean);
  if (devices.length > 0) raw.devices = Array.from(new Set(devices));

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
    return { ok: false, reason: `Condições inválidas: ${issue.path.join(".") || "?"}: ${issue.message}` };
  }
  return { ok: true, value: parsed.data };
}

/** Converte as condições gravadas para as linhas do formulário. */
export function conditionsToForm(c: RouteConditions | null | undefined): {
  countries: string;
  devices: Device[];
  query: QueryRuleRow[];
  referrer: string;
  bot: boolean;
} {
  const query: QueryRuleRow[] = Object.entries(c?.query ?? {}).map(([key, rule]) =>
    typeof rule === "string" ? { key, mode: rule, value: "" } : { key, mode: "equals", value: rule.equals },
  );
  return {
    countries: (c?.countries ?? []).join(", "),
    devices: [...(c?.devices ?? [])],
    query,
    referrer: c?.referrer ?? "",
    bot: c?.bot === true,
  };
}

/** Resumo curto para a tabela de rotas. */
export function summarizeConditions(c: RouteConditions | null | undefined): string {
  if (!c) return "Sempre";
  const parts: string[] = [];
  if (c.countries?.length) parts.push(`País: ${c.countries.join(", ")}`);
  if (c.devices?.length) parts.push(`Dispositivo: ${c.devices.map((d) => DEVICE_LABELS[d]).join(", ")}`);
  for (const [key, rule] of Object.entries(c.query ?? {})) {
    parts.push(typeof rule === "string" ? `?${key} ${QUERY_MODE_LABELS[rule]}` : `?${key} = ${rule.equals}`);
  }
  if (c.referrer) parts.push(`Referrer contém "${c.referrer}"`);
  if (c.bot) parts.push("Só bots/crawlers");
  return parts.length ? parts.join(" · ") : "Sempre";
}
