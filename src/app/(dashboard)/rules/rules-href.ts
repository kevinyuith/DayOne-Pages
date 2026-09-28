import { DEFAULT_RANGE, type RangeKey } from "@/lib/pages/dashboard-filters";

/** The Rules screen's URL: the period of the numbers (?range=, left out when it's the default) and the flow (?flow=). */
export function rulesHref(range: RangeKey, flow: string | null): string {
  const qs = new URLSearchParams();
  if (range !== DEFAULT_RANGE) qs.set("range", range);
  if (flow) qs.set("flow", flow);
  const s = qs.toString();
  return s ? `/rules?${s}` : "/rules";
}
