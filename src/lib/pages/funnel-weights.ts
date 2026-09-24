import { supabaseService } from "@/lib/supabase/service";

/**
 * The % of the A/B test between the pages of a funnel, in the database (`weight`
 * of each page in pages.funnels.site, excluding archived ones). The math lives
 * in traffic.ts; this only reads and writes what changed.
 */

export async function loadFunnelWeights(funnelId: string): Promise<Record<string, number>> {
  const { data, error } = await supabaseService().rpc("funnel_pages_summary", { p_funnel_ids: [funnelId] });
  if (error) throw new Error(error.message);
  return Object.fromEntries(((data ?? []) as { page_id: string; status: string; weight: number }[]).filter((p) => p.status !== "ARCHIVED").map((p) => [p.page_id, p.weight]));
}

/** Writes the new weights that differ from the current ones. */
export async function writeFunnelWeights(funnelId: string, current: Record<string, number>, next: Record<string, number>): Promise<void> {
  const changed = Object.fromEntries(Object.entries(next).filter(([id, w]) => current[id] !== w));
  if (!Object.keys(changed).length) return;
  const { error } = await supabaseService().rpc("funnel_set_weights", { p_funnel: funnelId, p_weights: changed });
  if (error) throw new Error(error.message);
}
