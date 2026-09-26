/**
 * The Logs screen's filters (GET params, so a filtered page is a link and the
 * pagination keeps them). Only known values pass: anything else is no filter.
 */

export const HIT_FILTER_OPTIONS = {
  result: [
    ["served", "Served"],
    ["redirect", "Redirect"],
    ["notfound", "404"],
    ["error", "Error"],
  ],
  rule: [
    ["any", "Any rule"],
    ["bot", "Bot"],
    ["suspicious", "Suspicious"],
    ["none", "No rule"],
  ],
  unique: [
    ["unique", "Unique"],
    ["repeat", "Repeat"],
  ],
  funnel: [
    ["sent", "Sent to a funnel"],
    ["no_funnel_token", "No [F…] in sub1"],
    ["slug_not_allowed", "Slug not allowed"],
    ["funnel_not_live", "Funnel: no live page"],
    ["domain_disabled", "Domain: disabled"],
    ["domain_locked", "Domain: locked"],
    ["domain_unlocked", "Domain: unlocked"],
  ],
  interaction: [
    ["yes", "Interacted"],
    ["clicked", "Clicked out"],
    ["none", "No interaction"],
  ],
  device: [
    ["desktop", "Desktop"],
    ["mobile", "Mobile"],
    ["tablet", "Tablet"],
  ],
} as const satisfies Record<string, readonly (readonly [string, string])[]>;

type Options = typeof HIT_FILTER_OPTIONS;
export type HitFilters = { [K in keyof Options]?: Options[K][number][0] } & {
  /** ISO 3166 alpha-2, uppercase. */
  country?: string;
  /** An exact IPv4/IPv6 address. */
  ip?: string;
};

type Params = { [key: string]: string | string[] | undefined };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

/** The filters in the URL; unknown values are dropped. */
export function parseHitFilters(params: Params): HitFilters {
  const f: HitFilters = {};
  for (const key of Object.keys(HIT_FILTER_OPTIONS) as (keyof Options)[]) {
    const v = one(params[key]);
    if (HIT_FILTER_OPTIONS[key].some(([value]) => value === v)) (f as Record<string, string>)[key] = v;
  }
  const country = one(params.country).toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) f.country = country;
  const ip = one(params.ip);
  if (/^[0-9A-Fa-f:.]{2,45}$/.test(ip) && (ip.includes(".") || ip.includes(":"))) f.ip = ip;
  return f;
}

/** The filters as query params (for links that keep them). */
export function hitFilterParams(f: HitFilters): [string, string][] {
  return Object.entries(f).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "");
}
