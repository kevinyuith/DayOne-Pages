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

/**
 * The traffic rules' conditions (pages.rules) = the domain filter's + the
 * click's sub ids and a User-Agent regex (only rules have them; the domain
 * filter and the PHP KNOWN_CONDITIONS keep the base contract).
 */
const subId = z.string().min(1).max(200);
/** A generic URL parameter of the click: the name plus exactly one matcher. */
const paramRule = z
  .strictObject({
    name: z.string().regex(/^[A-Za-z0-9._~-]{1,100}$/, "invalid parameter name"),
    equals: z.string().min(1).max(300).optional(),
    contains: z.string().min(1).max(300).optional(),
    present: z.literal(true).optional(),
    not_equals: z.string().min(1).max(300).optional(),
    absent_or_equals: z.string().min(1).max(300).optional(),
  })
  .refine((p) => [p.equals !== undefined, p.contains !== undefined, p.present !== undefined, p.not_equals !== undefined, p.absent_or_equals !== undefined].filter(Boolean).length === 1, {
    message: "choose exactly one of equals, contains, present, not equals or absent or equals",
  });
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An IPv6 address (with "::" and an optional dotted IPv4 tail). */
function isIpv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.split("::").length > 2) return false;
  let groups = s;
  const tail = s.slice(s.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    if (!IPV4_RE.test(tail)) return false;
    groups = `${s.slice(0, s.lastIndexOf(":") + 1)}0:0`;
  }
  const [head, rest] = groups.split("::");
  const all = [...(head ? head.split(":") : []), ...(rest ? rest.split(":") : [])];
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  return rest === undefined ? all.length === 8 : all.length < 8;
}

/** An IP or a CIDR range: "203.0.113.7", "10.0.0.0/8", "2001:db8::/32" (the database checks it again, as inet). */
export function isIpOrRange(s: string): boolean {
  const [ip, bits, extra] = s.split("/");
  if (extra !== undefined) return false;
  const v4 = IPV4_RE.test(ip);
  if (!v4 && !isIpv6(ip)) return false;
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (v4 ? 32 : 128));
}

export const ruleConditionsSchema = conditionsSchema
  .extend({
    sub1: subId.optional(),
    sub11: subId.optional(),
    param: paramRule.optional(),
    user_agent: z.string().min(1).max(500).optional(),
    user_agent_mode: z.literal("block").optional(),
    // The click's IP (IPs and CIDR ranges), its AS number and its hostname (reverse DNS, a regex).
    ips: z.array(z.string().refine(isIpOrRange, "invalid IP or range")).min(1).max(200).optional(),
    ips_mode: z.literal("block").optional(),
    asns: z.array(z.number().int().min(1).max(4294967295)).min(1).max(200).optional(),
    asns_mode: z.literal("block").optional(),
    hostname: z.string().min(1).max(500).optional(),
    hostname_mode: z.literal("block").optional(),
  })
  .refine((c) => !c.user_agent_mode || (c.user_agent?.length ?? 0) > 0, { message: "user_agent_mode requires user_agent", path: ["user_agent_mode"] })
  .refine((c) => !c.ips_mode || (c.ips?.length ?? 0) > 0, { message: "ips_mode requires ips", path: ["ips_mode"] })
  .refine((c) => !c.asns_mode || (c.asns?.length ?? 0) > 0, { message: "asns_mode requires asns", path: ["asns_mode"] })
  .refine((c) => !c.hostname_mode || (c.hostname?.length ?? 0) > 0, { message: "hostname_mode requires hostname", path: ["hostname_mode"] });

export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

/** The generic parameter's matcher, in the form. */
export type ParamMode = "equals" | "contains" | "present" | "not_equals" | "absent_or_equals";

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

// ── Traffic rules ────────────────────────────────────────────────────────────

/**
 * Reads a rule's conditions from the rule form. The same fields as the domain
 * filter (minus `bot`), plus `sub1`, `sub11` (exact), `user_agent` and
 * `hostname` (regexes), `ips` (IPs/CIDR ranges) and `asns` (AS numbers, "AS"
 * prefix optional) — each with its `_mode` "block" to invert. The regexes are
 * validated for real (they must compile — the server runs them per click).
 */
export function parseRuleConditionsForm(fd: FormData): { ok: true; value: RuleConditions } | { ok: false; reason: string } {
  // The rule form adds URL parameters one by one: "contains" goes once, and a parameter only once.
  const paramNames = fd.getAll("param_name").map((v) => String(v).trim()).filter(Boolean);
  if (paramNames.length > 1) return { ok: false, reason: "Only one URL parameter can use contains." };
  const queryKeys = fd.getAll("query_key").map((v) => String(v).trim()).filter(Boolean);
  const twice = [...queryKeys, ...paramNames].find((k, i, all) => all.indexOf(k) !== i);
  if (twice) return { ok: false, reason: `The URL parameter "${twice}" is there twice.` };

  const base = parseConditionsForm(fd);
  if (!base.ok) return base;
  if (base.value.bot) return { ok: false, reason: "The bot condition doesn't apply to a traffic rule (bots are the domain's block)." };

  const raw: Record<string, unknown> = { ...base.value };
  const sub1 = String(fd.get("sub1") ?? "").trim();
  if (sub1) raw.sub1 = sub1;
  const sub11 = String(fd.get("sub11") ?? "").trim();
  if (sub11) raw.sub11 = sub11;

  // A generic URL parameter: the name plus exactly one matcher.
  const paramName = String(fd.get("param_name") ?? "").trim();
  if (paramName) {
    const mode = String(fd.get("param_mode") ?? "present");
    const value = String(fd.get("param_value") ?? "").trim();
    if (mode === "equals") {
      if (!value) return { ok: false, reason: "The parameter needs a value (equals)." };
      raw.param = { name: paramName, equals: value };
    } else if (mode === "not_equals") {
      if (!value) return { ok: false, reason: "The parameter needs a value (not equals)." };
      raw.param = { name: paramName, not_equals: value };
    } else if (mode === "absent_or_equals") {
      if (!value) return { ok: false, reason: "The parameter needs a value (absent or equals)." };
      raw.param = { name: paramName, absent_or_equals: value };
    } else if (mode === "contains") {
      if (!value) return { ok: false, reason: "The parameter needs a value (contains)." };
      raw.param = { name: paramName, contains: value };
    } else {
      raw.param = { name: paramName, present: true };
    }
  }

  const tokens = (name: string) => Array.from(new Set(String(fd.get(name) ?? "").split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)));

  const ips = tokens("ips");
  if (ips.length) {
    const bad = ips.find((ip) => !isIpOrRange(ip));
    if (bad) return { ok: false, reason: `"${bad}" isn't an IP or range (e.g. 203.0.113.7 or 10.0.0.0/8).` };
    raw.ips = ips;
    if (String(fd.get("ips_mode") ?? "allow") === "block") raw.ips_mode = "block";
  }

  const asnTokens = tokens("asns");
  if (asnTokens.length) {
    const asns: number[] = [];
    for (const t of asnTokens) {
      const n = Number(/^(?:AS)?(\d{1,10})$/i.exec(t)?.[1] ?? NaN);
      if (!Number.isInteger(n) || n < 1 || n > 4294967295) return { ok: false, reason: `"${t}" isn't an AS number (e.g. 16509 or AS16509).` };
      asns.push(n);
    }
    raw.asns = Array.from(new Set(asns));
    if (String(fd.get("asns_mode") ?? "allow") === "block") raw.asns_mode = "block";
  }

  const hostname = String(fd.get("hostname") ?? "").trim();
  if (hostname) {
    try {
      new RegExp(hostname, "i");
    } catch {
      return { ok: false, reason: "The hostname regex doesn't compile." };
    }
    raw.hostname = hostname;
    if (String(fd.get("hostname_mode") ?? "allow") === "block") raw.hostname_mode = "block";
  }

  const ua = String(fd.get("user_agent") ?? "").trim();
  if (ua) {
    try {
      // Compile-check with the case-insensitive flag the server uses.
      new RegExp(ua, "i");
    } catch {
      return { ok: false, reason: "The User-Agent regex doesn't compile." };
    }
    raw.user_agent = ua;
    if (String(fd.get("user_agent_mode") ?? "allow") === "block") raw.user_agent_mode = "block";
  }

  const parsed = ruleConditionsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `Invalid conditions: ${issue.path.join(".") || "?"}: ${issue.message}` };
  }
  return { ok: true, value: parsed.data };
}

/** Converts a rule's saved conditions into the form rows (the base ones + sub ids + generic param + UA regex). */
export function ruleConditionsToForm(c: RuleConditions | null | undefined): ReturnType<typeof conditionsToForm> & {
  sub1: string;
  sub11: string;
  paramName: string;
  paramMode: ParamMode;
  paramValue: string;
  userAgent: string;
  userAgentMode: ListMode;
  ips: string;
  ipsMode: ListMode;
  asns: string;
  asnsMode: ListMode;
  hostname: string;
  hostnameMode: ListMode;
} {
  const p = c?.param;
  return {
    ...conditionsToForm(c),
    sub1: c?.sub1 ?? "",
    sub11: c?.sub11 ?? "",
    paramName: p?.name ?? "",
    paramMode:
      p?.equals !== undefined ? "equals" : p?.not_equals !== undefined ? "not_equals" : p?.absent_or_equals !== undefined ? "absent_or_equals" : p?.contains !== undefined ? "contains" : "present",
    paramValue: p?.equals ?? p?.not_equals ?? p?.absent_or_equals ?? p?.contains ?? "",
    userAgent: c?.user_agent ?? "",
    userAgentMode: c?.user_agent_mode === "block" ? "block" : "allow",
    ips: (c?.ips ?? []).join(", "),
    ipsMode: c?.ips_mode === "block" ? "block" : "allow",
    asns: (c?.asns ?? []).join(", "),
    asnsMode: c?.asns_mode === "block" ? "block" : "allow",
    hostname: c?.hostname ?? "",
    hostnameMode: c?.hostname_mode === "block" ? "block" : "allow",
  };
}

/** Short summary of a rule's conditions, for the rules table. */
export function summarizeRuleConditions(c: RuleConditions | null | undefined): string {
  if (!c) return "Always";
  const parts: string[] = [];
  if (c.sub11) parts.push(`sub11 = ${c.sub11}`);
  if (c.sub1) parts.push(`sub1 = ${c.sub1}`);
  if (c.param)
    parts.push(
      `?${c.param.name} ${
        c.param.equals !== undefined
          ? `= ${c.param.equals}`
          : c.param.not_equals !== undefined
            ? `!= ${c.param.not_equals}`
            : c.param.absent_or_equals !== undefined
              ? `absent or = ${c.param.absent_or_equals}`
              : c.param.contains !== undefined
                ? `~ ${c.param.contains}`
                : "present"
      }`,
    );
  if (c.user_agent) parts.push(`UA ${c.user_agent_mode === "block" ? "not " : ""}~ /${c.user_agent}/i`);
  if (c.ips?.length) parts.push(`IP ${c.ips_mode === "block" ? "not " : ""}in ${c.ips.join(", ")}`);
  if (c.asns?.length) parts.push(`ASN ${c.asns_mode === "block" ? "not " : ""}in ${c.asns.join(", ")}`);
  if (c.hostname) parts.push(`Hostname ${c.hostname_mode === "block" ? "not " : ""}~ /${c.hostname}/i`);
  const base = summarizeConditions(c);
  if (base !== "Always") parts.push(base);
  return parts.length ? parts.join(" · ") : "Always";
}
