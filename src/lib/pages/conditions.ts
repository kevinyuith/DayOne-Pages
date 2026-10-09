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
 *   referrer_absent true = the Referer header is empty (no referrer at all).
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

export const QUERY_MODES = ["present", "absent", "empty", "equals"] as const;
export type QueryMode = (typeof QUERY_MODES)[number];
export const QUERY_MODE_LABELS: Record<QueryMode, string> = { present: "present", absent: "absent", empty: "absent or empty", equals: "equals" };

const queryRule = z.union([z.literal("present"), z.literal("absent"), z.literal("empty"), z.strictObject({ equals: z.string().min(1).max(200) })]);

export const conditionsSchema = z
  .strictObject({
    countries: z.array(z.string().regex(/^[A-Z]{2}$/, "country must be a two-letter code")).min(1).max(50).optional(),
    countries_mode: z.literal("block").optional(),
    devices: z.array(z.enum(DEVICES)).min(1).optional(),
    languages: z.array(z.string().regex(/^[a-z]{2}$/, "language must be a two-letter code (ISO 639-1)")).min(1).max(50).optional(),
    languages_mode: z.literal("block").optional(),
    query: z.record(z.string().regex(/^[A-Za-z0-9_.\-\[\]]{1,100}$/, "invalid parameter name"), queryRule).optional(),
    referrer: z.string().min(1).max(200).optional(),
    referrer_absent: z.literal(true).optional(),
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

/** A screen size, "WxH" (the database checks the same pattern). */
const SCREEN_RE = /^\d{2,5}x\d{2,5}$/;

export const ruleConditionsSchema = conditionsSchema
  .extend({
    sub1: subId.optional(),
    sub11: subId.optional(),
    param: paramRule.optional(),
    user_agent: z.string().min(1).max(500).optional(),
    user_agent_mode: z.literal("block").optional(),
    // Only a prefetch: the page loaded ahead of a click (X-Moz / Sec-Purpose / Purpose: prefetch).
    prefetch: z.literal(true).optional(),
    // The number of language tags in Accept-Language: a bot often sends a bare
    // "en" (one tag), a real browser sends "en-US,en" (two). {max: 1} flags it.
    accept_languages: z
      .strictObject({
        min: z.number().int().min(0).max(50).optional(),
        max: z.number().int().min(0).max(50).optional(),
      })
      .refine((a) => a.min !== undefined || a.max !== undefined, { message: "min or max required" })
      .optional(),
    // The click's IP (IPs and CIDR ranges), its AS number and its hostname (reverse DNS, a regex).
    ips: z.array(z.string().refine(isIpOrRange, "invalid IP or range")).min(1).max(200).optional(),
    ips_mode: z.literal("block").optional(),
    asns: z.array(z.number().int().min(1).max(4294967295)).min(1).max(200).optional(),
    asns_mode: z.literal("block").optional(),
    hostname: z.string().min(1).max(500).optional(),
    hostname_mode: z.literal("block").optional(),
    // ── The device signals (the checkpoint, server/src/eval.php) — only the
    // browser knows them; the gate's Suspicious stage runs there.
    // eval_cookie "absent" = the visitor never passed the checkpoint.
    eval_cookie: z.literal("absent").optional(),
    touch: z.union([z.literal(0), z.literal(1)]).optional(),
    mobile_hint: z.union([z.literal(0), z.literal(1)]).optional(),
    pointer: z.enum(["coarse", "fine", "none"]).optional(),
    webdriver: z.union([z.literal(0), z.literal(1)]).optional(),
    automation: z.union([z.literal(0), z.literal(1)]).optional(),
    gl_software: z.union([z.literal(0), z.literal(1)]).optional(),
    platform: z.string().min(1).max(60).optional(),
    iframe: z.union([z.literal(0), z.literal(1)]).optional(),
    tostring_tampered: z.union([z.literal(0), z.literal(1)]).optional(),
    proto_poisoned: z.union([z.literal(0), z.literal(1)]).optional(),
    tz_offset: z.number().int().min(-840).max(840).optional(),
    // net_rtt_min: Chrome's RTT estimate (navigator.connection.rtt, ms) is at least this; no measurement never matches.
    net_rtt_min: z.number().int().min(1).max(10000).optional(),
    // nav_ttfb_above: the checkpoint page's time to first byte is above this (ms, strictly); no timing never matches.
    nav_ttfb_above: z.number().int().min(1).max(10000).optional(),
    // coast: the browser's time zone is on that US coast (east / west); no zone never matches.
    coast: z.enum(["east", "west"]).optional(),
    // device_memory (GB, navigator.deviceMemory) and plugins (navigator.plugins.length) are exact; chrome_below is the Chrome major version under which a UA matches; nav_connect_min is the checkpoint page's TCP+TLS setup in ms.
    device_memory: z.number().int().min(1).max(1024).optional(),
    plugins: z.number().int().min(0).max(1000).optional(),
    chrome_below: z.number().int().min(1).max(1000).optional(),
    nav_connect_min: z.number().int().min(1).max(10000).optional(),
    // screens: the screen (screen.width x screen.height) is one of these "WxH", either orientation; no size never matches.
    screens: z.array(z.string().regex(SCREEN_RE, "a size is WxH, e.g. 800x600")).min(1).max(50).optional(),
    // The on/off detectors (1 = the tell fired). no_js is decided on the GET
    // (the page served, no POST back), the rest from the browser's signals.
    no_touch: z.union([z.literal(0), z.literal(1)]).optional(),
    chrome_ua: z.union([z.literal(0), z.literal(1)]).optional(),
    no_chrome_object: z.union([z.literal(0), z.literal(1)]).optional(),
    tz_mismatch: z.union([z.literal(0), z.literal(1)]).optional(),
    // tz_not_us: the browser's IANA zone is outside the home list (US + territories, Canada, Mexico, nearby Caribbean).
    tz_not_us: z.union([z.literal(0), z.literal(1)]).optional(),
    no_js: z.union([z.literal(0), z.literal(1)]).optional(),
    no_cookie: z.union([z.literal(0), z.literal(1)]).optional(),
    odd_resolution: z.union([z.literal(0), z.literal(1)]).optional(),
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

  if (fd.get("referrer_absent") === "on" || fd.get("referrer_absent") === "true") raw.referrer_absent = true;

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
  referrerAbsent: boolean;
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
    referrerAbsent: c?.referrer_absent === true,
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
  if (c.referrer_absent) parts.push("No referrer");
  if (c.bot) parts.push("Bots/crawlers only");
  return parts.length ? parts.join(" · ") : "Always";
}

// ── Traffic rules ────────────────────────────────────────────────────────────

/**
 * Reads a rule's conditions from the rule form. The same fields as the domain
 * filter (minus `bot`), plus `sub1`, `sub11` (exact), `user_agent` and
 * `hostname` (regexes), `ips` (IPs/CIDR ranges) and `asns` (AS numbers, "AS"
 * prefix optional) — each with its `_mode` "block" to invert — and `prefetch`
 * (checkbox). The regexes are validated for real (they must compile — the
 * server runs them per click).
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

  if (fd.get("prefetch") === "on" || fd.get("prefetch") === "true") raw.prefetch = true;

  // The Accept-Language tag count (min and/or max, independent).
  const alMin = String(fd.get("accept_languages_min") ?? "").trim();
  const alMax = String(fd.get("accept_languages_max") ?? "").trim();
  if (alMin !== "" || alMax !== "") {
    const al: { min?: number; max?: number } = {};
    if (alMin !== "" && /^\d{1,2}$/.test(alMin)) al.min = Number(alMin);
    if (alMax !== "" && /^\d{1,2}$/.test(alMax)) al.max = Number(alMax);
    if (al.min !== undefined || al.max !== undefined) raw.accept_languages = al;
  }

  // The device signals (the checkpoint's browser stage). Each comes as a
  // select: "" = not used, otherwise the value.
  const bit = (name: string): 0 | 1 | undefined => {
    const v = String(fd.get(name) ?? "");
    return v === "1" ? 1 : v === "0" ? 0 : undefined;
  };
  const touch = bit("touch");
  if (touch !== undefined) raw.touch = touch;
  const mobileHint = bit("mobile_hint");
  if (mobileHint !== undefined) raw.mobile_hint = mobileHint;
  const pointer = String(fd.get("pointer") ?? "");
  if (pointer === "coarse" || pointer === "fine" || pointer === "none") raw.pointer = pointer;
  const webdriver = bit("webdriver");
  if (webdriver !== undefined) raw.webdriver = webdriver;
  const automation = bit("automation");
  if (automation !== undefined) raw.automation = automation;
  const glSoftware = bit("gl_software");
  if (glSoftware !== undefined) raw.gl_software = glSoftware;
  const platform = String(fd.get("signal_platform") ?? "").trim();
  if (platform) raw.platform = platform;
  const iframe = bit("iframe");
  if (iframe !== undefined) raw.iframe = iframe;
  const tostringTampered = bit("tostring_tampered");
  if (tostringTampered !== undefined) raw.tostring_tampered = tostringTampered;
  const protoPoisoned = bit("proto_poisoned");
  if (protoPoisoned !== undefined) raw.proto_poisoned = protoPoisoned;
  const tzOffset = String(fd.get("tz_offset") ?? "").trim();
  if (tzOffset !== "" && /^-?\d{1,4}$/.test(tzOffset)) raw.tz_offset = Number(tzOffset);
  const netRttMin = String(fd.get("net_rtt_min") ?? "").trim();
  if (netRttMin !== "") {
    if (!/^\d{1,5}$/.test(netRttMin) || Number(netRttMin) < 1 || Number(netRttMin) > 10000) return { ok: false, reason: "Chrome RTT must be whole milliseconds, 1–10000." };
    raw.net_rtt_min = Number(netRttMin);
  }
  const navTtfbAbove = String(fd.get("nav_ttfb_above") ?? "").trim();
  if (navTtfbAbove !== "") {
    if (!/^\d{1,5}$/.test(navTtfbAbove) || Number(navTtfbAbove) < 1 || Number(navTtfbAbove) > 10000) return { ok: false, reason: "Checkpoint TTFB must be whole milliseconds, 1–10000." };
    raw.nav_ttfb_above = Number(navTtfbAbove);
  }
  const coast = String(fd.get("coast") ?? "");
  if (coast === "east" || coast === "west") raw.coast = coast;
  for (const [field, min, max, label] of [
    ["device_memory", 1, 1024, "Device memory must be whole GB, 1–1024."],
    ["plugins", 0, 1000, "Plugins must be a whole count, 0–1000."],
    ["chrome_below", 1, 1000, "Chrome version must be a whole major version, 1–1000."],
    ["nav_connect_min", 1, 10000, "Connect time must be whole milliseconds, 1–10000."],
  ] as const) {
    const v = String(fd.get(field) ?? "").trim();
    if (v === "") continue;
    if (!/^\d{1,5}$/.test(v) || Number(v) < min || Number(v) > max) return { ok: false, reason: label };
    raw[field] = Number(v);
  }
  const screens = Array.from(new Set(String(fd.get("screens") ?? "").toLowerCase().replace(/×/g, "x").split(/[\s,;]+/).filter(Boolean)));
  if (screens.length) {
    const bad = screens.find((s) => !SCREEN_RE.test(s));
    if (bad) return { ok: false, reason: `Invalid screen size "${bad}" (WxH, e.g. 800x600).` };
    if (screens.length > 50) return { ok: false, reason: "Up to 50 screen sizes." };
    raw.screens = screens;
  }
  if (fd.get("eval_cookie") === "absent") raw.eval_cookie = "absent";
  // The on/off detectors.
  const noTouch = bit("no_touch");
  if (noTouch !== undefined) raw.no_touch = noTouch;
  const chromeUa = bit("chrome_ua");
  if (chromeUa !== undefined) raw.chrome_ua = chromeUa;
  const noChromeObject = bit("no_chrome_object");
  if (noChromeObject !== undefined) raw.no_chrome_object = noChromeObject;
  const tzMismatch = bit("tz_mismatch");
  if (tzMismatch !== undefined) raw.tz_mismatch = tzMismatch;
  const tzNotUs = bit("tz_not_us");
  if (tzNotUs !== undefined) raw.tz_not_us = tzNotUs;
  const noJs = bit("no_js");
  if (noJs !== undefined) raw.no_js = noJs;
  const noCookie = bit("no_cookie");
  if (noCookie !== undefined) raw.no_cookie = noCookie;
  const oddResolution = bit("odd_resolution");
  if (oddResolution !== undefined) raw.odd_resolution = oddResolution;

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
  prefetch: boolean;
  acceptLanguagesMin: string;
  acceptLanguagesMax: string;
  ips: string;
  ipsMode: ListMode;
  asns: string;
  asnsMode: ListMode;
  hostname: string;
  hostnameMode: ListMode;
  evalCookie: boolean;
  touch: "" | "0" | "1";
  mobileHint: "" | "0" | "1";
  pointer: "" | "coarse" | "fine" | "none";
  webdriver: "" | "0" | "1";
  automation: "" | "0" | "1";
  glSoftware: "" | "0" | "1";
  signalPlatform: string;
  iframe: "" | "0" | "1";
  tostringTampered: "" | "0" | "1";
  protoPoisoned: "" | "0" | "1";
  tzOffset: string;
  netRttMin: string;
  navTtfbAbove: string;
  coast: "" | "east" | "west";
  deviceMemory: string;
  plugins: string;
  chromeBelow: string;
  navConnectMin: string;
  screens: string;
  noTouch: "" | "0" | "1";
  chromeUa: "" | "0" | "1";
  noChromeObject: "" | "0" | "1";
  tzMismatch: "" | "0" | "1";
  tzNotUs: "" | "0" | "1";
  noJs: "" | "0" | "1";
  noCookie: "" | "0" | "1";
  oddResolution: "" | "0" | "1";
} {
  const p = c?.param;
  const bit = (v: 0 | 1 | undefined): "" | "0" | "1" => (v === 1 ? "1" : v === 0 ? "0" : "");
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
    prefetch: c?.prefetch === true,
    acceptLanguagesMin: c?.accept_languages?.min !== undefined ? String(c.accept_languages.min) : "",
    acceptLanguagesMax: c?.accept_languages?.max !== undefined ? String(c.accept_languages.max) : "",
    ips: (c?.ips ?? []).join(", "),
    ipsMode: c?.ips_mode === "block" ? "block" : "allow",
    asns: (c?.asns ?? []).join(", "),
    asnsMode: c?.asns_mode === "block" ? "block" : "allow",
    hostname: c?.hostname ?? "",
    hostnameMode: c?.hostname_mode === "block" ? "block" : "allow",
    evalCookie: c?.eval_cookie === "absent",
    touch: bit(c?.touch),
    mobileHint: bit(c?.mobile_hint),
    pointer: c?.pointer ?? "",
    webdriver: bit(c?.webdriver),
    automation: bit(c?.automation),
    glSoftware: bit(c?.gl_software),
    signalPlatform: c?.platform ?? "",
    iframe: bit(c?.iframe),
    tostringTampered: bit(c?.tostring_tampered),
    protoPoisoned: bit(c?.proto_poisoned),
    tzOffset: c?.tz_offset !== undefined ? String(c.tz_offset) : "",
    netRttMin: c?.net_rtt_min !== undefined ? String(c.net_rtt_min) : "",
    navTtfbAbove: c?.nav_ttfb_above !== undefined ? String(c.nav_ttfb_above) : "",
    coast: c?.coast ?? "",
    deviceMemory: c?.device_memory !== undefined ? String(c.device_memory) : "",
    plugins: c?.plugins !== undefined ? String(c.plugins) : "",
    chromeBelow: c?.chrome_below !== undefined ? String(c.chrome_below) : "",
    navConnectMin: c?.nav_connect_min !== undefined ? String(c.nav_connect_min) : "",
    screens: (c?.screens ?? []).join(", "),
    noTouch: bit(c?.no_touch),
    chromeUa: bit(c?.chrome_ua),
    noChromeObject: bit(c?.no_chrome_object),
    tzMismatch: bit(c?.tz_mismatch),
    tzNotUs: bit(c?.tz_not_us),
    noJs: bit(c?.no_js),
    noCookie: bit(c?.no_cookie),
    oddResolution: bit(c?.odd_resolution),
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
  if (c.prefetch) parts.push("Prefetch");
  if (c.accept_languages) {
    const { min, max } = c.accept_languages;
    if (min !== undefined && max !== undefined) parts.push(`Languages ${min}–${max}`);
    else if (max !== undefined) parts.push(`Languages ≤ ${max}`);
    else if (min !== undefined) parts.push(`Languages ≥ ${min}`);
  }
  if (c.ips?.length) parts.push(`IP ${c.ips_mode === "block" ? "not " : ""}in ${c.ips.join(", ")}`);
  if (c.asns?.length) parts.push(`ASN ${c.asns_mode === "block" ? "not " : ""}in ${c.asns.join(", ")}`);
  if (c.hostname) parts.push(`Hostname ${c.hostname_mode === "block" ? "not " : ""}~ /${c.hostname}/i`);
  const base = summarizeConditions(c);
  if (base !== "Always") parts.push(base);
  // The device signals (the checkpoint's browser stage).
  if (c.eval_cookie === "absent") parts.push("No checkpoint");
  const onOff = (v: 0 | 1 | undefined, on: string, off: string) => (v === 1 ? on : v === 0 ? off : "");
  const sig = [
    onOff(c.touch, "Touchscreen", "No touchscreen"),
    onOff(c.mobile_hint, "Mobile hint", "No mobile hint"),
    c.pointer ? `Pointer ${c.pointer}` : "",
    onOff(c.webdriver, "Webdriver", "No webdriver"),
    onOff(c.automation, "Automation", "No automation"),
    onOff(c.gl_software, "Software GL", "Hardware GL"),
    c.platform ? `Platform ~ ${c.platform}` : "",
    onOff(c.iframe, "In iframe", "Not in iframe"),
    onOff(c.tostring_tampered, "toString tampered", ""),
    onOff(c.proto_poisoned, "Proto poisoned", ""),
    c.tz_offset !== undefined ? `TZ offset ${c.tz_offset}` : "",
    c.net_rtt_min !== undefined ? `Chrome RTT ≥ ${c.net_rtt_min} ms` : "",
    c.nav_ttfb_above !== undefined ? `Checkpoint TTFB > ${c.nav_ttfb_above} ms` : "",
    c.coast ? `Coast ${c.coast}` : "",
    c.device_memory !== undefined ? `Device memory = ${c.device_memory} GB` : "",
    c.plugins !== undefined ? `Plugins = ${c.plugins}` : "",
    c.chrome_below !== undefined ? `Chrome < ${c.chrome_below}` : "",
    c.nav_connect_min !== undefined ? `Connect ≥ ${c.nav_connect_min} ms` : "",
    c.screens?.length ? `Screen ${c.screens.join(", ")}` : "",
    onOff(c.no_touch, "No touch", "Has touch"),
    onOff(c.chrome_ua, "Chrome UA", "Not Chrome UA"),
    onOff(c.no_chrome_object, "No window.chrome", ""),
    onOff(c.tz_mismatch, "TZ mismatch", ""),
    onOff(c.tz_not_us, "Non-US/CA/MX timezone", ""),
    onOff(c.no_js, "No JS", ""),
    onOff(c.no_cookie, "Cookies off", ""),
    onOff(c.odd_resolution, "Odd resolution", ""),
  ].filter(Boolean);
  if (sig.length) parts.push(sig.join(", "));
  return parts.length ? parts.join(" · ") : "Always";
}
