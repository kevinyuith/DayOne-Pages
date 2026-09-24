/**
 * The three traffic series, shared by the chart and the cards (the same
 * color marks the same series in both). This file has no "use client" on
 * purpose: page.tsx (server) reads the values from here.
 *
 * Validated colors (scripts/validate_palette.js from the dataviz skill, all
 * pairs, surfaces #ffffff and #141414): lightness band, chroma, CVD
 * (worst pair 8.6), normal vision and contrast pass in both modes. Green and
 * red match the table's Served/Blocked badges; violet matches "Bot".
 */
export const SERIES = [
  { key: "served", label: "Served", color: "#059669" },
  { key: "blocked", label: "Blocked", color: "#dc2626" },
  { key: "bots", label: "Bots", color: "#7c3aed" },
] as const;

export type SeriesKey = (typeof SERIES)[number]["key"];

export const SERIES_COLOR = Object.fromEntries(SERIES.map((s) => [s.key, s.color])) as Record<SeriesKey, string>;
