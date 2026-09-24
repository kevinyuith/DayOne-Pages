import { supabaseService } from "@/lib/supabase/service";

/**
 * Os % do teste A/B entre as páginas de um funil, no banco
 * (pages.traffic_weight das páginas não arquivadas do funil). As contas ficam
 * em traffic.ts; aqui só se lê e grava o que mudou.
 */

export async function loadFunnelWeights(funnelId: string): Promise<Record<string, number>> {
  const { data, error } = await supabaseService().from("pages").select("id, traffic_weight").eq("funnel_id", funnelId).neq("status", "ARCHIVED").order("created_at");
  if (error) throw new Error(error.message);
  return Object.fromEntries(((data ?? []) as { id: string; traffic_weight: number }[]).map((p) => [p.id, p.traffic_weight]));
}

/** Grava os pesos novos que diferem dos atuais. */
export async function writeFunnelWeights(current: Record<string, number>, next: Record<string, number>): Promise<void> {
  const db = supabaseService();
  for (const [id, w] of Object.entries(next)) {
    if (current[id] === w) continue;
    const { error } = await db.from("pages").update({ traffic_weight: w }).eq("id", id);
    if (error) throw new Error(error.message);
  }
}
