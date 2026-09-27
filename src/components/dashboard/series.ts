/**
 * The Traffic chart's four series, shared by the chart and the cards (the same
 * color marks the same series in both). All are UNIQUE visitors (distinct IPs)
 * per bucket: a rule labeled them Bot or Suspicious, they passed the gate (a
 * funnel page served by the gate), and of those, their page loaded. This file
 * has no "use client" on purpose: page.tsx (server) reads the values from here.
 *
 * Validated colors (scripts/validate_palette.js from the dataviz skill, all
 * pairs, surfaces #ffffff and #141414): lightness band, chroma, CVD (worst
 * pair 8.6), normal vision (worst 16.9) and contrast pass in both modes.
 * Violet matches "Bot", red the Suspicious card, green the Loaded card.
 */
export const SERIES = [
  { key: "bots", label: "Bots", color: "#7c3aed" },
  { key: "suspicious", label: "Suspicious", color: "#dc2626" },
  { key: "passed", label: "Passed", color: "#0284c7" },
  { key: "loaded", label: "Loaded", color: "#059669" },
] as const;

export type SeriesKey = (typeof SERIES)[number]["key"];

export const SERIES_COLOR = Object.fromEntries(SERIES.map((s) => [s.key, s.color])) as Record<SeriesKey, string>;
