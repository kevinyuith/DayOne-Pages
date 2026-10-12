import type { RuleConditions } from "@/lib/pages/conditions";
import { localMidnight } from "@/lib/time-zone";

/**
 * The Rules screen's arithmetic, with no React and no I/O: the local days of
 * the trend, the spikes, the Monitor verdict and a rule's platforms.
 */

const HOUR_MS = 3_600_000;

/** Days the trend shows, and the days before them that only feed the first days' medians. */
export const TREND_DAYS = 14;
export const SPIKE_LOOKBACK = 7;

/**
 * The starts of the last `days` New York days (today last), ascending, plus
 * tomorrow's midnight to close today: `days + 1` instants. A NY day has 23, 24
 * or 25 hours, so every edge comes from localMidnight (36 h after today's
 * midnight is tomorrow whatever DST does).
 */
export function dayBounds(nowMs: number, days: number): number[] {
  const out: number[] = [];
  for (let k = days - 1; k >= 0; k--) out.push(localMidnight(nowMs, k));
  out.push(localMidnight(localMidnight(nowMs) + 36 * HOUR_MS));
  return out;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const SPIKE_MIN = 50;
export const SPIKE_FACTOR = 3;

/** A day whose count jumped: `day` indexes the counts given to findSpikes. */
export type Spike = { day: number; count: number; median: number };

/**
 * The spikes among `counts` (one per local day, starting at `starts[i]`): a day
 * with at least SPIKE_MIN clicks and at least SPIKE_FACTOR × the median of the
 * up to SPIKE_LOOKBACK days before it that are on or after the rule's creation
 * day (a median of 0 qualifies). A day with no such earlier day has nothing to
 * compare with and is never a spike. Only days from `from` on are reported.
 */
export function findSpikes(counts: number[], starts: number[], createdMs: number, from = 0): Spike[] {
  const day = Number.isFinite(createdMs) ? localMidnight(createdMs) : NaN;
  const createdDay = Number.isNaN(day) ? -Infinity : day;
  const out: Spike[] = [];
  for (let i = from; i < counts.length; i++) {
    const count = counts[i];
    if (count < SPIKE_MIN || starts[i] < createdDay) continue;
    const before: number[] = [];
    for (let j = i - 1; j >= 0 && before.length < SPIKE_LOOKBACK && starts[j] >= createdDay; j--) before.push(counts[j]);
    if (!before.length) continue;
    const m = median(before);
    if (count >= SPIKE_FACTOR * m) out.push({ day: i, count, median: m });
  }
  return out;
}

/** Clicks that passed the gate, and of those how many loaded / interacted. */
export type PassedCounts = { passed: number; loaded: number; interacted: number };

export const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export type Verdict = "few" | "bot" | "human" | "unclear";
export const VERDICT_MIN = 20;
export const VERDICT_LABEL: Record<Verdict, string> = { few: "Too few", bot: "Bot-like", human: "Human-like", unclear: "Unclear" };

/**
 * What a Monitor rule's would-block clicks look like next to every click that
 * passed on its platforms: Bot-like when they interact at most half as often
 * or load at most 70% as often; Human-like when they interact at least 85% as
 * often; Unclear in between or without a baseline. Fewer than VERDICT_MIN: Too few.
 */
export function monitorVerdict(rule: PassedCounts, base: PassedCounts): Verdict {
  if (rule.passed < VERDICT_MIN) return "few";
  if (base.passed <= 0) return "unclear";
  // The rates compared cross-multiplied, in integers: a/b ≤ k·c/d ⟺ a·d ≤ k·c·b (no rounding at the edges).
  const interacted = rule.interacted * base.passed;
  const loaded = rule.loaded * base.passed;
  const baseInteracted = base.interacted * rule.passed;
  const baseLoaded = base.loaded * rule.passed;
  if ((baseInteracted > 0 && 2 * interacted <= baseInteracted) || (baseLoaded > 0 && 10 * loaded <= 7 * baseLoaded)) return "bot";
  if (baseInteracted > 0 && 20 * interacted >= 17 * baseInteracted) return "human";
  return "unclear";
}

/** The platforms a rule is scoped to (lowercase, as hits.platform keeps them): sub11_in, or a legacy sub11 / "sub11 equals". Empty = every platform. */
export function rulePlatforms(c: RuleConditions | null | undefined): string[] {
  const legacy = c?.query?.sub11;
  const all = [...(c?.sub11_in ?? []), c?.sub11 ?? "", typeof legacy === "object" ? legacy.equals : ""];
  return [...new Set(all.map((p) => p.trim().toLowerCase()).filter(Boolean))];
}

/** One entry per name, case-insensitive (a "TikTok" tag and a "tiktok" scope are the same platform); the first spelling wins. */
export function uniqueCaseless(names: string[]): string[] {
  const out = new Map<string, string>();
  for (const n of names) if (!out.has(n.toLowerCase())) out.set(n.toLowerCase(), n);
  return [...out.values()];
}

const pctFmt = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
const pctFmtFine = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

/** A share as text: one decimal under 10%, none above; "—" when there is no denominator. */
export function formatPct(r: number | null): string {
  if (r === null) return "—";
  return (r > 0 && r < 0.1 ? pctFmtFine : pctFmt).format(r);
}
