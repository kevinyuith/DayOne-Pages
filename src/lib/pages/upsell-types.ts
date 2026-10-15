import { z } from "zod";
import { DEVICES, DEVICE_LABELS, QUERY_MODES, type Device, type QueryMode } from "./conditions";
import { MAX_ALIASES, aliasesProblem } from "./vendor-paths";

/**
 * The upsell funnel of a vendor page (pages.upsell_funnels; the Upsells menu):
 * the steps after the checkout — Upsell 1…5 and the Thank you page. Shared by
 * the screen and the actions; the database checks the same shape
 * (pages.upsell_config_check) and the delivery server serves it
 * (server/src/upsell.php).
 *
 * - The buyers of an upsell step are split in GROUPS by what they bought at the
 *   front (the funnel's `front_param` in the URL: ?front=6). A group with no
 *   fronts takes any other front. The groups with the same fronts across the
 *   steps are one ROUTE, which the screen edits as a whole (funnelRoutes).
 * - FLOWS are the funnel's, in order: the first whose rule (`when`) matches the
 *   request takes the buyer; none → "default". The rule is the rules' base
 *   conditions (country, device, language, URL parameters, referrer) + cookies.
 * - The routing is internal: a step's path is fixed (/up1 … /up5, /thank-you —
 *   stepPath) and what it serves is decided by the funnel. A step is also served
 *   at its ALIASES (vendor-paths.ts): implicitly at the vendor page's folder +
 *   its path (/bg/up1), and at the `aliases` it lists (the URLs already
 *   registered on the platforms: /bg/up1v2 → Upsell 1).
 * - Per group: the PAGE versions of each flow (upsell pages: scope VENDOR, kind
 *   UPSELL, the vendor page's product and platform — served at the step's
 *   path), the VSL videos, the CTA (the offer: a checkout
 *   key of the product) and the DOWNSELLS (slots, each with its versions), all
 *   with shares (0–100, a list adds up to 100; 0 = paused). The page fills
 *   {{upsell.offer}} and {{upsell.downsell1}}, {{upsell.downsell2}}… with the
 *   picked keys' checkout values; its downsells run on the same page.
 * - The screen edits the DRAFT; Publish makes it the live config (history kept).
 */

export const UPSELL_STEPS = ["up1", "up2", "up3", "up4", "up5"] as const;
export type UpsellStepId = (typeof UPSELL_STEPS)[number] | "ty";
export const STEP_LABELS: Record<UpsellStepId, string> = {
  up1: "Upsell 1", up2: "Upsell 2", up3: "Upsell 3", up4: "Upsell 4", up5: "Upsell 5", ty: "Thank you",
};
export const DEFAULT_FLOW = "default";
export const DEFAULT_FRONT_PARAM = "front";
export const MAX_FLOWS = 10;
export const MAX_GROUPS = 6;
export const MAX_VERSIONS = 10;
export const MAX_DOWNSELLS = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const weight = z.number().int("Shares are whole numbers.").min(0).max(100);
const queryRule = z.union([z.literal("present"), z.literal("absent"), z.literal("empty"), z.strictObject({ equals: z.string().min(1).max(200) })]);
const paramName = z.string().regex(/^[A-Za-z0-9_.\-\[\]]{1,100}$/, "invalid parameter name");

/** A flow's rule: the rules' base conditions (server/src/conditions.php) + cookies. */
export const flowWhenSchema = z.strictObject({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(50).optional(),
  countries_mode: z.literal("block").optional(),
  devices: z.array(z.enum(DEVICES)).min(1).optional(),
  languages: z.array(z.string().regex(/^[a-z]{2}$/)).min(1).max(50).optional(),
  languages_mode: z.literal("block").optional(),
  query: z.record(paramName, queryRule).optional(),
  referrer: z.string().min(1).max(200).optional(),
  referrer_absent: z.literal(true).optional(),
  cookies: z.record(z.string().regex(/^[A-Za-z0-9_.\-]{1,100}$/, "invalid cookie name"), queryRule).optional(),
});
export type FlowWhen = z.infer<typeof flowWhenSchema>;

const pageVersion = z.strictObject({ page_id: z.string().regex(UUID_RE, "an upsell page"), weight });
const vslVersion = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9]{1,40}$/, "a VTurb video id"), weight });
const offerVersion = z.strictObject({ offer: z.string().regex(KEY_RE, "a checkout key"), weight });

export const upsellGroupSchema = z.strictObject({
  id: z.string().regex(/^g[a-z0-9]{1,12}$/),
  name: z.string().trim().min(1).max(60),
  fronts: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/)).max(10),
  pages: z.record(z.string(), z.array(pageVersion).max(MAX_VERSIONS)),
  vsls: z.array(vslVersion).max(MAX_VERSIONS).optional(),
  offers: z.array(offerVersion).max(MAX_VERSIONS).optional(),
  downsells: z.array(z.array(offerVersion).min(1).max(MAX_VERSIONS)).max(MAX_DOWNSELLS).optional(),
});
export type UpsellGroup = z.infer<typeof upsellGroupSchema>;

/** A step's path on the vendor domain: fixed (the routing is internal). */
export function stepPath(id: UpsellStepId): string {
  return id === "ty" ? "/thank-you" : `/${id}`;
}

export const upsellStepSchema = z
  .strictObject({
    id: z.enum([...UPSELL_STEPS, "ty"]),
    slug: z.string(),
    /** Other paths this step is served at (vendor-paths.ts aliasProblem; checked across the funnel below). */
    aliases: z.array(z.string()).max(MAX_ALIASES).optional(),
    groups: z.array(upsellGroupSchema).min(1).max(MAX_GROUPS).optional(),
  })
  .refine((s) => s.slug === stepPath(s.id), { message: "A step's path is fixed (/up1 … /up5, /thank-you)." });
export type UpsellStep = z.infer<typeof upsellStepSchema>;

export const upsellFlowSchema = z.strictObject({
  id: z.string().regex(/^f[a-z0-9]{1,12}$/),
  name: z.string().trim().min(1).max(60),
  when: flowWhenSchema,
});
export type UpsellFlow = z.infer<typeof upsellFlowSchema>;

export const upsellConfigSchema = z
  .strictObject({
    front_param: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/).optional(),
    flows: z.array(upsellFlowSchema).max(MAX_FLOWS),
    steps: z.array(upsellStepSchema).max(6),
  })
  .superRefine((c, ctx) => {
    const flows = new Set(c.flows.map((f) => f.id));
    if (flows.size !== c.flows.length) ctx.addIssue({ code: "custom", message: "Two flows have the same id." });
    const steps = c.steps.map((s) => s.id);
    if (new Set(steps).size !== steps.length) ctx.addIssue({ code: "custom", message: "A step appears twice." });
    const aliases = aliasesProblem(c.steps.map((s) => ({ canonical: stepPath(s.id), aliases: s.aliases ?? [] })));
    if (aliases) ctx.addIssue({ code: "custom", message: aliases });
    for (const s of c.steps) {
      if (s.id !== "ty" && !s.groups?.length) ctx.addIssue({ code: "custom", message: `${STEP_LABELS[s.id]} needs a group.` });
      for (const g of s.groups ?? []) {
        for (const key of Object.keys(g.pages)) {
          if (key !== DEFAULT_FLOW && !flows.has(key)) ctx.addIssue({ code: "custom", message: `${STEP_LABELS[s.id]} · ${g.name}: pages of a flow that no longer exists.` });
        }
      }
    }
  });
export type UpsellConfig = z.infer<typeof upsellConfigSchema>;

export function emptyConfig(): UpsellConfig {
  return { front_param: DEFAULT_FRONT_PARAM, flows: [], steps: [] };
}

/** A short random id with the given prefix (g… for groups, f… for flows). */
export function newId(prefix: "g" | "f"): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

/** A group with nothing chosen yet. */
function emptyGroup(name: string, fronts: string[]): UpsellGroup {
  return { id: newId("g"), name, fronts: [...fronts], pages: { [DEFAULT_FLOW]: [] }, offers: [], vsls: [], downsells: [] };
}

/** A new upsell step: one group per route of the funnel (or one for every buyer), no page chosen yet. */
export function newUpsellStep(id: (typeof UPSELL_STEPS)[number], routes: Pick<UpsellRoute, "name" | "fronts">[] = []): UpsellStep {
  const groups = routes.length ? routes.slice(0, MAX_GROUPS).map((r) => emptyGroup(r.name, r.fronts)) : [emptyGroup("All buyers", [])];
  return { id, slug: stepPath(id), groups };
}

/** The first config of a new funnel: Upsell 1–3 (/up1, /up2, /up3) and the Thank you page. */
export function initialConfig(): UpsellConfig {
  return { front_param: DEFAULT_FRONT_PARAM, flows: [], steps: [newUpsellStep("up1"), newUpsellStep("up2"), newUpsellStep("up3"), { id: "ty", slug: stepPath("ty") }] };
}

/** The lists of shares that don't add up to 100 (each one a readable place). Publishing needs none. */
export function shareProblems(c: UpsellConfig): string[] {
  const out: string[] = [];
  const flowName = (id: string) => (id === DEFAULT_FLOW ? "Default" : (c.flows.find((f) => f.id === id)?.name ?? id));
  const check = (where: string, list: { weight: number }[] | undefined) => {
    if (!list || list.length === 0) return;
    const sum = list.reduce((a, v) => a + v.weight, 0);
    if (sum !== 100) out.push(`${where}: ${sum}%`);
  };
  for (const s of c.steps) {
    for (const g of s.groups ?? []) {
      const at = `${STEP_LABELS[s.id]} · ${g.name}`;
      for (const [flow, list] of Object.entries(g.pages)) check(`${at} · ${flowName(flow)} pages`, list);
      check(`${at} · VSL`, g.vsls);
      check(`${at} · CTA`, g.offers);
      (g.downsells ?? []).forEach((slot, i) => check(`${at} · Downsell ${i + 1}`, slot));
    }
  }
  return out;
}

// ── Routes: the buyers by front, across every upsell step ──────────────────

/**
 * A ROUTE is what the buyers bought at the front, followed through the whole
 * funnel: the upsell steps' groups with the same fronts are one route (the
 * stored config doesn't change — the server still picks each step's group by
 * its fronts). The screen creates, renames and re-fronts a route in every step
 * at once, so a route can't exist in Upsell 1 and silently miss Upsell 2. A step
 * where a route has no group gives its buyers the step's fallback: the group
 * with no fronts, else its first group (upsell.php's upsell_group).
 */
export type UpsellRoute = {
  /** Its fronts, sorted ("" = any other front). */
  key: string;
  name: string;
  fronts: string[];
  /** The route's group at each upsell step; a step that isn't here has none. */
  groups: Partial<Record<UpsellStepId, string>>;
};

export const ROUTE_NAME_MAX = 60;
const FRONT_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_FRONTS = 10;

/** A route's identity: its fronts, sorted ("" = any other front). */
export function routeKey(fronts: readonly string[]): string {
  return [...new Set(fronts)].sort().join(",");
}

/** The upsell steps (no Thank you), in order. */
function upsellSteps(c: UpsellConfig): UpsellStep[] {
  return c.steps.filter((s) => s.id !== "ty");
}

/** The funnel's routes: routes with fronts in order of appearance, then "any other". */
export function funnelRoutes(c: UpsellConfig): UpsellRoute[] {
  const byKey = new Map<string, UpsellRoute>();
  for (const s of upsellSteps(c)) {
    for (const g of s.groups ?? []) {
      const key = routeKey(g.fronts);
      let r = byKey.get(key);
      if (!r) {
        r = { key, name: g.name, fronts: [...new Set(g.fronts)], groups: {} };
        byKey.set(key, r);
      }
      // Two groups with the same fronts in one step: the server only ever picks the first.
      r.groups[s.id] ??= g.id;
    }
  }
  const all = [...byKey.values()];
  return [...all.filter((r) => r.key !== ""), ...all.filter((r) => r.key === "")];
}

/** The group a step gives the buyers of a route it has no group for (upsell.php: no fronts, else the first). */
export function fallbackGroup(step: UpsellStep): UpsellGroup | undefined {
  return step.groups?.find((g) => g.fronts.length === 0) ?? step.groups?.[0];
}

/** "6, 3 6" → ["6", "3"]; an error when a value is not a front. */
export function parseFronts(text: string): { fronts: string[] } | { error: string } {
  const fronts = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  const bad = fronts.find((f) => !FRONT_RE.test(f));
  if (bad) return { error: `“${bad.slice(0, 40)}” is not a front value (letters, numbers, . _ -).` };
  if (fronts.length > MAX_FRONTS) return { error: `At most ${MAX_FRONTS} front values per route.` };
  return { fronts };
}

/** Why these fronts can't be a route's (another route has one of them, or also takes any other front); null = they can. */
function frontsConflict(c: UpsellConfig, fronts: string[], exceptKey: string | null): string | null {
  for (const r of funnelRoutes(c)) {
    if (r.key === exceptKey) continue;
    if (fronts.length === 0 && r.key === "") return `${r.name} already takes any other front.`;
    const shared = fronts.find((f) => r.fronts.includes(f));
    if (shared) return `${shared} is already in ${r.name}.`;
  }
  return null;
}

function cleanName(name: string): string | { error: string } {
  const n = name.trim();
  if (!n) return { error: "Give the route a name." };
  if (n.length > ROUTE_NAME_MAX) return { error: `A route's name has at most ${ROUTE_NAME_MAX} characters.` };
  return n;
}

/** Adds a route to every upsell step (in place). An error message, or null. */
export function routeAdd(c: UpsellConfig, name: string, fronts: string[]): string | null {
  const n = cleanName(name);
  if (typeof n !== "string") return n.error;
  const conflict = frontsConflict(c, fronts, null);
  if (conflict) return conflict;
  const full = upsellSteps(c).find((s) => (s.groups?.length ?? 0) >= MAX_GROUPS);
  if (full) return `${STEP_LABELS[full.id]} already has ${MAX_GROUPS} routes.`;
  for (const s of upsellSteps(c)) s.groups = [...(s.groups ?? []), emptyGroup(n, fronts)];
  return null;
}

/** Renames a route and changes its fronts in every step (in place). An error message, or null. */
export function routeUpdate(c: UpsellConfig, key: string, name: string, fronts: string[]): string | null {
  const n = cleanName(name);
  if (typeof n !== "string") return n.error;
  const conflict = frontsConflict(c, fronts, key);
  if (conflict) return conflict;
  for (const s of upsellSteps(c)) {
    for (const g of s.groups ?? []) {
      if (routeKey(g.fronts) !== key) continue;
      g.name = n;
      g.fronts = [...fronts];
    }
  }
  return null;
}

/** Takes a route out of every step (in place). Refused when a step would be left with no group. */
export function routeRemove(c: UpsellConfig, key: string): string | null {
  const alone = upsellSteps(c).find((s) => (s.groups ?? []).every((g) => routeKey(g.fronts) === key));
  if (alone) return `${STEP_LABELS[alone.id]} has no other route: remove the step or add another route first.`;
  for (const s of upsellSteps(c)) s.groups = (s.groups ?? []).filter((g) => routeKey(g.fronts) !== key);
  return null;
}

/** Gives a route its own (empty) group, with this id, in a step where it had none (in place). An error message, or null. */
export function routeAddToStep(c: UpsellConfig, route: Pick<UpsellRoute, "name" | "fronts">, stepId: UpsellStepId, groupId: string): string | null {
  const s = c.steps.find((x) => x.id === stepId);
  if (!s || s.id === "ty") return "No such step.";
  if ((s.groups?.length ?? 0) >= MAX_GROUPS) return `${STEP_LABELS[s.id]} already has ${MAX_GROUPS} routes.`;
  s.groups = [...(s.groups ?? []), { ...emptyGroup(route.name, route.fronts), id: groupId }];
  return null;
}

/** Takes a route out of one step: its buyers get the step's fallback there. Refused for the step's last group. */
export function routeRemoveFromStep(c: UpsellConfig, key: string, stepId: UpsellStepId): string | null {
  const s = c.steps.find((x) => x.id === stepId);
  if (!s?.groups) return null;
  const rest = s.groups.filter((g) => routeKey(g.fronts) !== key);
  if (rest.length === 0) return `This is ${STEP_LABELS[s.id]}'s only route.`;
  s.groups = rest;
  return null;
}

// ── A flow's rule, in words ─────────────────────────────────────────────────

export const RULE_KINDS = ["cookie", "param", "country", "device", "language", "referrer", "no_referrer"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const RULE_KIND_LABELS: Record<RuleKind, string> = {
  cookie: "Cookie",
  param: "URL parameter",
  country: "Country",
  device: "Device",
  language: "Language",
  referrer: "Referrer contains",
  no_referrer: "No referrer",
};

/** One editable line of a flow's rule. `name` = cookie/parameter name; `values` = countries, devices or languages. */
export type RuleRow = { kind: RuleKind; name: string; mode: QueryMode; value: string; values: string[]; block: boolean };

export function ruleRows(w: FlowWhen): RuleRow[] {
  const rows: RuleRow[] = [];
  const base = { name: "", mode: "present" as QueryMode, value: "", values: [] as string[], block: false };
  const fromRule = (r: unknown): Pick<RuleRow, "mode" | "value"> =>
    typeof r === "object" && r !== null && "equals" in r ? { mode: "equals", value: String((r as { equals: string }).equals) } : { mode: (r as QueryMode) ?? "present", value: "" };
  for (const [name, r] of Object.entries(w.cookies ?? {})) rows.push({ ...base, kind: "cookie", name, ...fromRule(r) });
  for (const [name, r] of Object.entries(w.query ?? {})) rows.push({ ...base, kind: "param", name, ...fromRule(r) });
  if (w.countries) rows.push({ ...base, kind: "country", values: w.countries, block: w.countries_mode === "block" });
  if (w.devices) rows.push({ ...base, kind: "device", values: w.devices });
  if (w.languages) rows.push({ ...base, kind: "language", values: w.languages, block: w.languages_mode === "block" });
  if (w.referrer) rows.push({ ...base, kind: "referrer", value: w.referrer });
  if (w.referrer_absent) rows.push({ ...base, kind: "no_referrer" });
  return rows;
}

/** The rows back into a rule (an incomplete row is left out). */
export function rowsToWhen(rows: RuleRow[]): FlowWhen {
  const w: FlowWhen = {};
  const rule = (r: RuleRow) => (r.mode === "equals" ? { equals: r.value.trim() } : r.mode);
  for (const r of rows) {
    if (r.kind === "cookie" && r.name.trim() && (r.mode !== "equals" || r.value.trim())) (w.cookies ??= {})[r.name.trim()] = rule(r);
    if (r.kind === "param" && r.name.trim() && (r.mode !== "equals" || r.value.trim())) (w.query ??= {})[r.name.trim()] = rule(r);
    if (r.kind === "country" && r.values.length) {
      w.countries = r.values.map((v) => v.toUpperCase());
      if (r.block) w.countries_mode = "block";
    }
    if (r.kind === "device" && r.values.length) w.devices = r.values.filter((v): v is Device => (DEVICES as readonly string[]).includes(v));
    if (r.kind === "language" && r.values.length) {
      w.languages = r.values.map((v) => v.toLowerCase());
      if (r.block) w.languages_mode = "block";
    }
    if (r.kind === "referrer" && r.value.trim()) w.referrer = r.value.trim();
    if (r.kind === "no_referrer") w.referrer_absent = true;
  }
  return w;
}

/** The rule as short tags for the flow's header ("cookie vsl_ok", "sub11 = taboola", "US"…). */
export function ruleChips(w: FlowWhen): string[] {
  const chip = (name: string, r: unknown) =>
    typeof r === "object" && r !== null && "equals" in r ? `${name} = ${(r as { equals: string }).equals}` : r === "present" ? name : `${name} ${r}`;
  const out: string[] = [];
  for (const [n, r] of Object.entries(w.cookies ?? {})) out.push(`cookie ${chip(n, r)}`);
  for (const [n, r] of Object.entries(w.query ?? {})) out.push(chip(n, r));
  if (w.countries) out.push(`${w.countries_mode === "block" ? "not " : ""}${w.countries.join(", ")}`);
  if (w.devices) out.push(w.devices.map((d) => DEVICE_LABELS[d]).join(", "));
  if (w.languages) out.push(`${w.languages_mode === "block" ? "not " : ""}lang ${w.languages.join(", ")}`);
  if (w.referrer) out.push(`referrer has ${w.referrer}`);
  if (w.referrer_absent) out.push("no referrer");
  return out;
}

export { QUERY_MODES };

// ── What changed between the live config and the draft ──────────────────────

/**
 * The draft's changes against the live config, in words (the publish bar and the
 * history's summary). `pageNames` names the upsell pages (their id otherwise).
 */
export function configChanges(live: UpsellConfig, draft: UpsellConfig, pageNames: Record<string, string> = {}): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const flowName = (id: string) => (id === DEFAULT_FLOW ? "Default" : (draft.flows.find((f) => f.id === id)?.name ?? live.flows.find((f) => f.id === id)?.name ?? id));
  const shares = (list: { weight: number; page_id?: string; id?: string; offer?: string }[] | undefined) =>
    (list ?? []).map((v) => `${v.page_id ? (pageNames[v.page_id] ?? v.page_id) : (v.id ?? v.offer)} ${v.weight}%`).join(", ") || "none";

  if ((live.front_param ?? DEFAULT_FRONT_PARAM) !== (draft.front_param ?? DEFAULT_FRONT_PARAM)) out.push(`Front parameter → ${draft.front_param}`);
  for (const f of draft.flows) {
    const was = live.flows.find((x) => x.id === f.id);
    if (!was) out.push(`New flow ${f.name}`);
    else {
      if (was.name !== f.name) out.push(`Flow ${was.name} renamed to ${f.name}`);
      if (!same(was.when, f.when)) out.push(`${f.name}: rule changed`);
    }
  }
  for (const f of live.flows) if (!draft.flows.some((x) => x.id === f.id)) out.push(`Flow ${f.name} removed`);
  const order = (c: UpsellConfig) => c.flows.map((f) => f.id).filter((id) => live.flows.some((x) => x.id === id) && draft.flows.some((x) => x.id === id));
  if (!same(order(live), order(draft))) out.push("Flow order changed");

  for (const s of draft.steps) {
    const was = live.steps.find((x) => x.id === s.id);
    const label = STEP_LABELS[s.id];
    if (!was) {
      out.push(`${label} added (${s.slug})`);
      continue;
    }
    if (!same(was.aliases ?? [], s.aliases ?? [])) out.push(`${label}: aliases ${(s.aliases ?? []).join(", ") || "none"}`);
    for (const g of s.groups ?? []) {
      const wg = was.groups?.find((x) => x.id === g.id);
      const at = `${label} · ${g.name}`;
      if (!wg) {
        out.push(`${at}: new group`);
        continue;
      }
      if (wg.name !== g.name) out.push(`${label}: group ${wg.name} renamed to ${g.name}`);
      if (!same(wg.fronts, g.fronts)) out.push(`${at}: fronts ${g.fronts.join(", ") || "any other"}`);
      for (const flow of new Set([...Object.keys(wg.pages), ...Object.keys(g.pages)])) {
        if (!same(wg.pages[flow], g.pages[flow])) out.push(`${at} · ${flowName(flow)}: pages ${shares(g.pages[flow])}`);
      }
      if (!same(wg.vsls, g.vsls)) out.push(`${at}: VSL ${shares(g.vsls)}`);
      if (!same(wg.offers, g.offers)) out.push(`${at}: CTA ${shares(g.offers)}`);
      const ds = Math.max(wg.downsells?.length ?? 0, g.downsells?.length ?? 0);
      for (let i = 0; i < ds; i++) {
        if (!same(wg.downsells?.[i], g.downsells?.[i])) out.push(`${at}: Downsell ${i + 1} ${g.downsells?.[i] ? shares(g.downsells[i]) : "removed"}`);
      }
    }
    for (const g of was.groups ?? []) if (!s.groups?.some((x) => x.id === g.id)) out.push(`${label}: group ${g.name} removed`);
  }
  for (const s of live.steps) if (!draft.steps.some((x) => x.id === s.id)) out.push(`${STEP_LABELS[s.id]} removed`);
  return out;
}
