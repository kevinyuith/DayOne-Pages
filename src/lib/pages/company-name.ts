/**
 * {{company.name}}: the legal name ({{company.llc}}) without the trailing legal
 * suffix — "Acme Health LLC" → "Acme Health", "Acme Comércio Ltda - ME" →
 * "Acme Comércio", "Acme GmbH & Co. KG" → "Acme". Strips one suffix at a time,
 * from the end backwards, until none is left; never returns empty (if the
 * legal name is only the suffix, it stays as is).
 *
 * The same list and rules are in server/src/placeholders.php —
 * change one, change the other (the tests on both sides use the same cases).
 *
 * Abbreviations that are also words (ME, SA, AS, MEI, SpA, Co…) are only stripped
 * when written the official way: "Wang Mei" and "Hotel Spa" stay whole.
 */

/** Case-insensitive. The trailing dot is optional in all of them. */
export const SUFFIXES_ANY_CASE = [
  "UG (haftungsbeschränkt)", "S.à r.l", "S.a.r.l", "Incorporated", "Corporation", "Company", "Limited",
  "L.L.L.P", "P.L.L.C", "L.L.C", "L.L.P", "P.L.C", "S.A.S", "S.R.L", "S.r.l", "S.p.A", "S.L.U", "LLLP", "PLLC",
  "EIRELI", "gGmbH", "GmbH", "KGaA", "SARL", "LTDA", "LLC", "LLP", "PLC", "Inc", "Corp", "Ltd", "Pty", "Pte",
  "OHG", "e.V", "S.A", "S/A", "S/S", "SRL", "S.L", "SLU", "N.V", "B.V", "A/S", "Oyj", "ApS", "K.K", "Sdn", "Bhd",
  "Tbk", "LDA", "EPP", "L.P", "P.C",
];

/** Only when written exactly like this (abbreviations that are also words). */
export const SUFFIXES_EXACT = ["Co", "CO", "AG", "KG", "UG", "SE", "SA", "SAS", "AB", "AS", "ASA", "NV", "BV", "LP", "PC", "SL", "SS", "KK", "ME", "MEI", "Oy", "SpA"];

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function suffixRe(list: string[], flags: string): RegExp {
  const alternatives = [...list].sort((a, b) => b.length - a.length).map(escape).join("|");
  // The suffix comes after a space, comma or dash, and may have a trailing dot.
  return new RegExp(`[\\s,\\-–—]+(?:${alternatives})\\.?$`, flags);
}

const ANY_CASE_RE = suffixRe(SUFFIXES_ANY_CASE, "iu");
const EXACT_RE = suffixRe(SUFFIXES_EXACT, "u");
const TRAILING_RE = /[\s,\-–—&]+$/u;

export function companyName(legalName: string): string {
  const original = legalName.trim();
  let name = original;
  for (let i = 0; i < 6; i++) {
    const m = name.match(ANY_CASE_RE) ?? name.match(EXACT_RE);
    if (!m || m.index === undefined || m.index === 0) break;
    const rest = name.slice(0, m.index).replace(TRAILING_RE, "");
    if (!rest) break;
    name = rest;
  }
  return name || original;
}
