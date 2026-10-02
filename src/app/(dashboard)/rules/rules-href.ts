import { DEFAULT_RANGE, type RangeKey } from "@/lib/pages/dashboard-filters";

/** A rule stage filter: show only Bot or only Suspicious (null = both). */
export type StageFilter = "bot" | "suspicious" | null;

/**
 * The Rules screen's URL: the period of the numbers (?range=, left out when it's
 * the default), the platform (?platform=), a text search (?q=) and the stage (?stage=).
 */
export function rulesHref(range: RangeKey, platform: string | null, q = "", stage: StageFilter = null): string {
  const qs = new URLSearchParams();
  if (range !== DEFAULT_RANGE) qs.set("range", range);
  if (platform) qs.set("platform", platform);
  if (q.trim()) qs.set("q", q.trim());
  if (stage) qs.set("stage", stage);
  const s = qs.toString();
  return s ? `/rules?${s}` : "/rules";
}
