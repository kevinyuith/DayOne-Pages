import { z } from "zod";

/**
 * The contract of the domain filter's conditions (`domains.filter`) — dashboard ⇄ database ⇄ PHP server.
 *
 * The database only returns the JSON; the server evaluates it (server/src/conditions.php),
 * and this schema guarantees its shape, on write. Every key is optional and
 * `{}` means "always matches". An unknown key is rejected here and treated
 * as "doesn't match" by the server.
 *
 *   countries       ISO-3166 alpha-2, uppercase. Comes from the CF-IPCountry header.
 *   countries_mode  "block" inverts the list: matches whoever is NOT in it. Absent = "allow only".
 *   devices         mobile | tablet | desktop, from the User-Agent.
 *   languages       ISO 639-1 (two letters), lowercase. Comes from the browser's Accept-Language.
 *   languages_mode  same as countries_mode, for languages.
 *   query           per parameter: "present" | "absent" | { equals: "value" }.
 *   referrer        text contained in the Referer header (case-insensitive).
 *   bot             true = crawler/scraper User-Agent. Only the domain's bot block uses it
 *                   (the filter rejects it). Meant for blocking, never for swapping content.
 */

export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export type Device = (typeof DEVICES)[number];
export const DEVICE_LABELS: Record<Device, string> = { mobile: "Mobile", tablet: "Tablet", desktop: "Desktop" };

/** Direction of a list (country/language): allow only the listed ones, or block the listed ones. */
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
  // A mode without its list decides nothing: reject it here so no junk gets saved.
  .refine((c) => !c.countries_mode || (c.countries?.length ?? 0) > 0, { message: "countries_mode requires countries", path: ["countries_mode"] })
  .refine((c) => !c.languages_mode || (c.languages?.length ?? 0) > 0, { message: "languages_mode requires languages", path: ["languages_mode"] });

export type RouteConditions = z.infer<typeof conditionsSchema>;

/** A row of the parameters form. */
export type QueryRuleRow = { key: string; mode: QueryMode; value: string };

/**
 * Reads the conditions from the FormData of the route/filter form.
 *
 * Fields: `countries` (text: "BR, US"), `countries_mode` ("allow"|"block"),
 * `devices` (checkboxes), `languages` (text: "en, es"), `languages_mode`
 * ("allow"|"block"), `query_key`, `query_mode`, `query_value` (parallel
 * lists), `referrer`, `bot` (checkbox). The mode is only saved when the
 * matching list exists; "allow" is the default and never goes into the JSON.
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

/** Converts the saved conditions into the form rows. */
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

/** Short summary for the routes table. */
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
