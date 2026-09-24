/**
 * As três séries do tráfego, compartilhadas pelo gráfico e pelos cards (a
 * mesma cor marca a mesma série nos dois). Arquivo sem "use client" de
 * propósito: o page.tsx (servidor) lê os valores daqui.
 *
 * Cores validadas (scripts/validate_palette.js da skill dataviz, todos os
 * pares, superfícies #ffffff e #141414): faixa de luminosidade, croma, CVD
 * (pior par 8.6), visão normal e contraste passam nos dois modos. Verde e
 * vermelho batem com os selos Served/Blocked da tabela; violeta com o "Bot".
 */
export const SERIES = [
  { key: "served", label: "Served", color: "#059669" },
  { key: "blocked", label: "Blocked", color: "#dc2626" },
  { key: "bots", label: "Bots", color: "#7c3aed" },
] as const;

export type SeriesKey = (typeof SERIES)[number]["key"];

export const SERIES_COLOR = Object.fromEntries(SERIES.map((s) => [s.key, s.color])) as Record<SeriesKey, string>;
