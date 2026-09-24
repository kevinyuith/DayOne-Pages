/**
 * The % of the A/B test between the pages of a funnel (`weight` in pages.funnels.site):
 * integers from 0 to 100 that ALWAYS sum to 100. Changing one page redistributes
 * the rest among the others in the proportion they already had; a page joining
 * or leaving rescales the others. The same math runs on the screen (preview) and
 * in the action (what gets saved).
 */

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 0)));

/** `total` split among `ids` in proportion to `weights` (all 0 = equal parts), as integers that sum to `total`. */
function spread(ids: string[], weights: Record<string, number>, total: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!ids.length) return out;
  const sum = ids.reduce((n, id) => n + Math.max(0, weights[id] ?? 0), 0);
  const raw = ids.map((id, i) => ({ id, i, v: sum === 0 ? total / ids.length : (Math.max(0, weights[id] ?? 0) * total) / sum }));
  let used = 0;
  for (const r of raw) {
    out[r.id] = Math.floor(r.v);
    used += out[r.id];
  }
  // The rounding leftover goes to the largest remainders (tie: whoever comes first).
  const order = [...raw].sort((a, b) => b.v - Math.floor(b.v) - (a.v - Math.floor(a.v)) || a.i - b.i);
  for (let k = 0; used < total; k++, used++) out[order[k % order.length].id]++;
  return out;
}

/** Equal parts: 50/50, 34/33/33… (the leftover goes to the first ones). */
export function evenSplit(ids: string[]): Record<string, number> {
  return spread(ids, {}, ids.length ? 100 : 0);
}

/** Page `id` gets `value`%; the others split the rest in the proportion they already had. A single page: 100. */
export function setShare(weights: Record<string, number>, id: string, value: number): Record<string, number> {
  const others = Object.keys(weights).filter((x) => x !== id);
  if (!others.length) return { [id]: 100 };
  const v = clamp(value);
  return { ...spread(others, weights, 100 - v), [id]: v };
}

/** The same weights rescaled to sum to 100 (after a page joins or leaves). */
export function normalizeShares(weights: Record<string, number>): Record<string, number> {
  return spread(Object.keys(weights), weights, 100);
}
