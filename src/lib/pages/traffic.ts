/**
 * Os % do teste A/B entre as páginas de um funil (pages.traffic_weight):
 * inteiros de 0 a 100 que SEMPRE somam 100. Mudar uma página redistribui o
 * resto entre as outras na proporção que elas já tinham; entrar ou sair uma
 * página reescala as outras. O mesmo cálculo roda na tela (prévia) e na
 * action (o que grava).
 */

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 0)));

/** `total` dividido entre `ids` na proporção de `weights` (todos 0 = partes iguais), em inteiros que somam `total`. */
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
  // A sobra do arredondamento vai para os maiores restos (empate: quem vem antes).
  const order = [...raw].sort((a, b) => b.v - Math.floor(b.v) - (a.v - Math.floor(a.v)) || a.i - b.i);
  for (let k = 0; used < total; k++, used++) out[order[k % order.length].id]++;
  return out;
}

/** Partes iguais: 50/50, 34/33/33… (a sobra fica com as primeiras). */
export function evenSplit(ids: string[]): Record<string, number> {
  return spread(ids, {}, ids.length ? 100 : 0);
}

/** A página `id` passa a ter `value`%; as outras dividem o resto na proporção que já tinham. Uma página só: 100. */
export function setShare(weights: Record<string, number>, id: string, value: number): Record<string, number> {
  const others = Object.keys(weights).filter((x) => x !== id);
  if (!others.length) return { [id]: 100 };
  const v = clamp(value);
  return { ...spread(others, weights, 100 - v), [id]: v };
}

/** Os mesmos pesos reescalados para somar 100 (depois de entrar ou sair uma página). */
export function normalizeShares(weights: Record<string, number>): Record<string, number> {
  return spread(Object.keys(weights), weights, 100);
}
