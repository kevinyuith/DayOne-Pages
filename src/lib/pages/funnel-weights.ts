import { supabaseService } from "@/lib/supabase/service";
import { setShare } from "./traffic";

/**
 * The % of the A/B test between the pages of a funnel, in the database (`weight`
 * of each page in pages.funnels.site). The math lives in traffic.ts; this only
 * reads and writes what changed.
 *
 * Only a PUBLISHED page gets traffic, so only published pages hold a share and
 * they add up to 100. A draft or archived page is left out of the math — its
 * stored value is left alone (a domain copy of it may still read it live). A
 * page joins the split when it is published and leaves it when it stops being.
 */

type PageRow = { page_id: string; name: string; status: string; weight: number; updated_at: string };

async function funnelPageRows(funnelId: string): Promise<PageRow[]> {
  const { data, error } = await supabaseService().rpc("funnel_pages_summary", { p_funnel_ids: [funnelId] });
  if (error) throw new Error(error.message);
  return (data ?? []) as PageRow[];
}

/** The % of the funnel's published pages (the only ones that get traffic). */
export async function loadFunnelWeights(funnelId: string): Promise<Record<string, number>> {
  return Object.fromEntries((await funnelPageRows(funnelId)).filter((p) => p.status === "PUBLISHED").map((p) => [p.page_id, p.weight]));
}

/** Writes the new weights that differ from the current ones. */
export async function writeFunnelWeights(funnelId: string, current: Record<string, number>, next: Record<string, number>): Promise<void> {
  const changed = Object.fromEntries(Object.entries(next).filter(([id, w]) => current[id] !== w));
  if (!Object.keys(changed).length) return;
  const { error } = await supabaseService().rpc("funnel_set_weights", { p_funnel: funnelId, p_weights: changed });
  if (error) throw new Error(error.message);
}

/** A page that just became published joins the split with 100/n; the others shrink in proportion. */
export async function joinFunnelSplit(funnelId: string, pageId: string): Promise<void> {
  const weights = await loadFunnelWeights(funnelId);
  if (!(pageId in weights)) return;
  await writeFunnelWeights(funnelId, weights, setShare(weights, pageId, 100 / Object.keys(weights).length));
}

/** Publishes a funnel page (its status only; the content is untouched). False = it changed elsewhere. */
export async function publishFunnelPage(funnelId: string, pageId: string): Promise<boolean> {
  const row = (await funnelPageRows(funnelId)).find((r) => r.page_id === pageId);
  if (!row) return false;
  const { data, error } = await supabaseService().rpc("funnel_page_save", {
    p_funnel: funnelId,
    p_page: pageId,
    p_name: row.name,
    p_status: "PUBLISHED",
    p_expected_page_updated_at: row.updated_at,
    p_slug: null,
    p_content: null,
    p_expected_slug_updated_at: null,
  });
  if (error) throw new Error(error.message);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** The page's status in the funnel (null = not in it). */
export async function funnelPageStatus(funnelId: string, pageId: string): Promise<string | null> {
  return (await funnelPageRows(funnelId)).find((r) => r.page_id === pageId)?.status ?? null;
}
