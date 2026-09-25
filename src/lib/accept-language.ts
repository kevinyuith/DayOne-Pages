/**
 * The languages of an Accept-Language header, most preferred first, without
 * the q weights: "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" → ["pt-BR", "pt",
 * "en-US", "en"]. A language with q=0 (refused), "*" and junk are left out;
 * the same language only once.
 */
export function languagesFromHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  const seen = new Set<string>();
  return header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.split(";").map((p) => p.trim());
      const q = params.find((p) => /^q=/i.test(p));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.weight > 0 && /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(x.tag))
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .map((x) => x.tag)
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
