/**
 * {{company.name}}: a razão social ({{company.llc}}) sem o sufixo jurídico do
 * final — "Acme Health LLC" → "Acme Health", "Acme Comércio Ltda - ME" →
 * "Acme Comércio", "Acme GmbH & Co. KG" → "Acme". Tira um sufixo por vez,
 * de trás para frente, até não sobrar nenhum; nunca devolve vazio (se a
 * razão social é só o sufixo, fica como está).
 *
 * A mesma lista e as mesmas regras estão em server/src/placeholders.php —
 * mudou uma, mude a outra (os testes dos dois lados usam os mesmos casos).
 *
 * Siglas que também são palavras (ME, SA, AS, MEI, SpA, Co…) só saem escritas
 * do jeito oficial: "Wang Mei" e "Hotel Spa" ficam inteiros.
 */

/** Sem diferença de maiúsculas. Ponto final é opcional em todos. */
const SUFFIXES_ANY_CASE = [
  "UG (haftungsbeschränkt)", "S.à r.l", "S.a.r.l", "Incorporated", "Corporation", "Company", "Limited",
  "L.L.L.P", "P.L.L.C", "L.L.C", "L.L.P", "P.L.C", "S.A.S", "S.R.L", "S.r.l", "S.p.A", "S.L.U", "LLLP", "PLLC",
  "EIRELI", "gGmbH", "GmbH", "KGaA", "SARL", "LTDA", "LLC", "LLP", "PLC", "Inc", "Corp", "Ltd", "Pty", "Pte",
  "OHG", "e.V", "S.A", "S/A", "S/S", "SRL", "S.L", "SLU", "N.V", "B.V", "A/S", "Oyj", "ApS", "K.K", "Sdn", "Bhd",
  "Tbk", "LDA", "EPP", "L.P", "P.C",
];

/** Só escritas assim (siglas que também são palavras). */
const SUFFIXES_EXACT = ["Co", "CO", "AG", "KG", "UG", "SE", "SA", "SAS", "AB", "AS", "ASA", "NV", "BV", "LP", "PC", "SL", "SS", "KK", "ME", "MEI", "Oy", "SpA"];

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function suffixRe(list: string[], flags: string): RegExp {
  const alternatives = [...list].sort((a, b) => b.length - a.length).map(escape).join("|");
  // O sufixo vem depois de espaço, vírgula ou traço, e pode ter ponto final.
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
