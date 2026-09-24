/**
 * Variação visual automática de um template: a mesma página (textos e
 * estrutura) com outro visual. Usada ao copiar um template para um domínio
 * ("Variação visual").
 *
 * Mexe só nos VALORES das declarações CSS que estão na própria página — em
 * <style> e em style="…" — e nas cores de SVG (fill, stroke, stop-color) e
 * da meta theme-color. Nunca em seletores, em @font-face nem em imagens. CSS
 * de arquivo externo (<link rel="stylesheet">) não muda, fora a fonte do
 * corpo, que ganha uma regra por cima.
 *
 * - Cores: gira o tom e ajusta um pouco saturação e luz; cinzas, quase-preto
 *   e quase-branco ficam como estão (texto e fundos neutros mantêm o contraste).
 * - Fontes: a primeira família de cada font-family vira outra do mesmo tipo
 *   (sem serifa → sem serifa, serifa → serifa), carregada do Google Fonts.
 *   Fontes de ícone e monoespaçadas ficam.
 * - Cantos e sombras: border-radius e box-shadow multiplicados por um fator
 *   (pílulas e porcentagens ficam).
 * - Espaçamentos: margin, padding e gap multiplicados por um fator.
 *
 * Tudo sai de uma semente (`seed`): a mesma semente dá a mesma variação, e
 * todas as slugs de um template usam os mesmos parâmetros.
 */

export type VariationOptions = { colors: boolean; fonts: boolean; shape: boolean; spacing: boolean };

export type VariationParams = {
  seed: number;
  /** Graus que o tom gira. */
  hue: number;
  /** Fator da saturação. */
  saturation: number;
  /** Deslocamento da luz (0–1). */
  lightness: number;
  sans: string;
  serif: string;
  radius: number;
  shadow: number;
  spacing: number;
};

type FontKind = "sans" | "serif";
/** Contagem de ajustes e as fontes que entraram de fato. */
export type VariationStats = { colors: number; fonts: number; radii: number; shadows: number; spacings: number; families: Partial<Record<FontKind, string>> };

const SANS = ["Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito Sans", "Source Sans 3", "Work Sans", "DM Sans", "Manrope", "Raleway", "Rubik", "Mulish", "IBM Plex Sans"];
const SERIF = ["Merriweather", "Lora", "Playfair Display", "PT Serif", "Source Serif 4", "Libre Baskerville", "EB Garamond", "Crimson Pro"];

/** PRNG pequeno e determinístico (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickVariation(seed: number = Math.floor(Math.random() * 2 ** 31)): VariationParams {
  const r = rng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)];
  return {
    seed,
    hue: Math.round((r() < 0.5 ? -1 : 1) * (40 + r() * 140)),
    saturation: Math.round((0.85 + r() * 0.3) * 100) / 100,
    lightness: Math.round((r() - 0.5) * 0.1 * 1000) / 1000,
    sans: pick(SANS),
    serif: pick(SERIF),
    radius: pick([0.35, 0.6, 1.6, 2.2]),
    shadow: pick([0.5, 0.75, 1.4, 1.8]),
    spacing: pick([0.82, 0.9, 1.12, 1.22]),
  };
}

// ── Cores ────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/**
 * Neutros ficam: cinzas, quase-preto, quase-branco e cinzas levemente
 * tingidos (bordas claras tipo #e5e7eb, textos escuros tipo #0f172a).
 */
function isNeutral(s: number, l: number): boolean {
  return s < 0.18 || l < 0.06 || l > 0.97 || (l > 0.85 && s < 0.35) || (l < 0.22 && s < 0.5);
}

/** Novo HSL para uma cor com cor de verdade; null para neutros (ficam). */
function shiftHsl(h: number, s: number, l: number, p: VariationParams): [number, number, number] | null {
  if (isNeutral(s, l)) return null;
  return [(((h + p.hue / 360) % 1) + 1) % 1, clamp(s * p.saturation, 0, 1), clamp(l + p.lightness, 0.04, 0.96)];
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");

const HEX_RE = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])/gi;
const RGB_RE = /rgba?\(\s*(\d*\.?\d+)(%?)\s*[,\s]\s*(\d*\.?\d+)(%?)\s*[,\s]\s*(\d*\.?\d+)(%?)\s*(?:[,/]\s*(\d*\.?\d+%?)\s*)?\)/gi;
const HSL_RE = /hsla?\(\s*(-?\d*\.?\d+)(?:deg)?\s*[,\s]\s*(\d*\.?\d+)%\s*[,\s]\s*(\d*\.?\d+)%\s*(?:[,/]\s*(\d*\.?\d+%?)\s*)?\)/gi;

function shiftColors(value: string, p: VariationParams, stats: VariationStats): string {
  return value
    .replace(HEX_RE, (m, hex: string) => {
      const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
      const alpha = full.length === 8 ? full.slice(6) : "";
      const next = shiftHsl(...rgbToHsl(r, g, b), p);
      if (!next) return m;
      stats.colors++;
      const [nr, ng, nb] = hslToRgb(...next);
      return `#${hex2(nr)}${hex2(ng)}${hex2(nb)}${alpha}`;
    })
    .replace(RGB_RE, (m, r: string, rp: string, g: string, gp: string, b: string, bp: string, a?: string) => {
      const ch = (v: string, pct: string) => (pct ? (parseFloat(v) * 255) / 100 : parseFloat(v));
      const next = shiftHsl(...rgbToHsl(ch(r, rp), ch(g, gp), ch(b, bp)), p);
      if (!next) return m;
      stats.colors++;
      const [nr, ng, nb] = hslToRgb(...next).map((n) => Math.round(clamp(n, 0, 255)));
      return a !== undefined ? `rgba(${nr}, ${ng}, ${nb}, ${a})` : `rgb(${nr}, ${ng}, ${nb})`;
    })
    .replace(HSL_RE, (m, h: string, s: string, l: string, a?: string) => {
      const next = shiftHsl(((parseFloat(h) % 360) + 360) % 360 / 360, parseFloat(s) / 100, parseFloat(l) / 100, p);
      if (!next) return m;
      stats.colors++;
      const [nh, ns, nl] = [Math.round(next[0] * 360), Math.round(next[1] * 100), Math.round(next[2] * 100)];
      return a !== undefined ? `hsla(${nh}, ${ns}%, ${nl}%, ${a})` : `hsl(${nh}, ${ns}%, ${nl}%)`;
    });
}

// ── Fontes ───────────────────────────────────────────────────────────────────

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "math", "emoji", "inherit", "initial", "unset", "revert", "-apple-system", "blinkmacsystemfont"]);
const KEEP_FONT = /icon|awesome|glyph|material symbols|fontello|icomoon|dashicons|mono|code|courier|consolas|menlo|monaco/i;
const SERIF_FONT = /georgia|times|garamond|merriweather|lora|playfair|baskerville|bodoni|caslon|cambria|palatino|antiqua|crimson|pt serif|source serif|noto serif|libre|didot|minion|charter|serif/i;

function splitFamilies(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = "";
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unquote = (s: string) => s.replace(/^["']|["']$/g, "").trim();

/** Troca a primeira família por uma do mesmo tipo (a mesma em toda a página). */
function swapFontFamily(value: string, p: VariationParams, stats: VariationStats): string {
  const important = /\s*!important\s*$/i.exec(value)?.[0] ?? "";
  const families = splitFamilies(value.slice(0, value.length - important.length));
  if (families.length === 0) return value;
  const first = unquote(families[0]);
  const firstLower = first.toLowerCase();
  if (KEEP_FONT.test(first) || firstLower === "var" || first.startsWith("var(")) return value;

  const generics = families.map((f) => unquote(f).toLowerCase());
  const serif = (SERIF_FONT.test(first) && !/sans/i.test(first)) || (generics.includes("serif") && !generics.includes("sans-serif"));
  const kind: FontKind = serif ? "serif" : "sans";
  let target = stats.families[kind];
  if (!target) {
    target = kind === "serif" ? p.serif : p.sans;
    const pool = kind === "serif" ? SERIF : SANS;
    // Sorteou a fonte que a página já usa: a próxima da lista, senão não muda nada.
    if (target.toLowerCase() === firstLower) target = pool[(pool.indexOf(target) + 1) % pool.length];
    stats.families[kind] = target;
  }
  stats.fonts++;
  const rest = GENERIC.has(firstLower) ? families : families.slice(1);
  return [`'${target}'`, ...rest].join(", ") + important;
}

// ── Tamanhos ────────────────────────────────────────────────────────────────

function scaleLengths(value: string, factor: number): string {
  return value.replace(/(-?\d*\.?\d+)(px|rem|em)(?![a-z])/g, (m, n: string, unit: string) => {
    const v = parseFloat(n);
    if (v === 0 || (unit === "px" && Math.abs(v) >= 500)) return m;
    const out = v * factor;
    const text = unit === "px" ? (Math.abs(out) >= 4 ? String(Math.round(out)) : String(Math.round(out * 10) / 10)) : String(Math.round(out * 1000) / 1000);
    return text + unit;
  });
}

const RADIUS_PROP = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;
const SPACING_PROP = /^(margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap|grid-gap)$/;

// ── Aplicar ─────────────────────────────────────────────────────────────────

function transformValue(prop: string, value: string, p: VariationParams, o: VariationOptions, stats: VariationStats): string {
  let v = value;
  if (o.colors && prop !== "font-family") v = shiftColors(v, p, stats);
  if (o.fonts && prop === "font-family") v = swapFontFamily(v, p, stats);
  if (o.shape && RADIUS_PROP.test(prop)) {
    const next = scaleLengths(v, p.radius);
    if (next !== v) stats.radii++;
    v = next;
  }
  if (o.shape && prop === "box-shadow" && !/none/i.test(v)) {
    const next = scaleLengths(v, p.shadow);
    if (next !== v) stats.shadows++;
    v = next;
  }
  if (o.spacing && SPACING_PROP.test(prop)) {
    const next = scaleLengths(v, p.spacing);
    if (next !== v) stats.spacings++;
    v = next;
  }
  return v;
}

/** Uma lista de declarações ("prop: valor; prop: valor"). */
function transformDeclarations(list: string, p: VariationParams, o: VariationOptions, stats: VariationStats): string {
  return list.replace(/(^|;)(\s*)([-a-zA-Z]+)(\s*:\s*)([^;]*)/g, (_m, sep: string, ws: string, prop: string, colon: string, value: string) =>
    sep + ws + prop + colon + transformValue(prop.toLowerCase(), value, p, o, stats),
  );
}

/** CSS de um <style>: só os blocos mais internos (declarações); @font-face fica. */
function transformCss(css: string, p: VariationParams, o: VariationOptions, stats: VariationStats): string {
  return css.replace(/(@font-face\s*)?\{([^{}]*)\}/gi, (m, fontFace: string | undefined, body: string) =>
    fontFace ? m : `{${transformDeclarations(body, p, o, stats)}}`,
  );
}

/** Google Fonts das famílias que entraram + a fonte do corpo por cima do CSS externo. */
function fontLinks(families: Partial<Record<FontKind, string>>): string {
  const bodyFont = families.sans ? `'${families.sans}', system-ui, sans-serif` : `'${families.serif}', Georgia, serif`;
  return (
    '<link rel="preconnect" href="https://fonts.googleapis.com" data-dop-variation>' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin data-dop-variation>' +
    Object.values(families)
      .map((f) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${f.replace(/ /g, "+")}:wght@400;700&display=swap" data-dop-variation>`)
      .join("") +
    `<style data-dop-variation>body{font-family:${bodyFont}}</style>`
  );
}

export function applyVariation(html: string, p: VariationParams, o: VariationOptions): { html: string; stats: VariationStats } {
  const stats: VariationStats = { colors: 0, fonts: 0, radii: 0, shadows: 0, spacings: 0, families: {} };

  let out = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, open: string, css: string, close: string) => open + transformCss(css, p, o, stats) + close);
  out = out.replace(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (_m, attr: string, q: string, css: string) => attr + q + transformDeclarations(css, p, o, stats) + q);
  if (o.colors) {
    out = out.replace(/(\s(?:fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*)(["'])([^"']*)\2/gi, (_m, attr: string, q: string, value: string) => attr + q + shiftColors(value, p, stats) + q);
    out = out.replace(/(<meta\b[^>]*name\s*=\s*["']theme-color["'][^>]*content\s*=\s*)(["'])([^"']*)\2/gi, (_m, pre: string, q: string, value: string) => pre + q + shiftColors(value, p, stats) + q);
  }

  if (o.fonts) {
    // Página só com CSS externo: a fonte do corpo muda mesmo sem font-family na página.
    if (!stats.families.sans && !stats.families.serif) {
      stats.families.sans = p.sans;
      stats.fonts++;
    }
    const links = fontLinks(stats.families);
    out = /<\/head\s*>/i.test(out) ? out.replace(/<\/head\s*>/i, (m) => links + m) : links + out;
  }
  return { html: out, stats };
}

/** Resumo legível do que a variação fez. */
export function describeVariation(p: VariationParams, o: VariationOptions, stats: VariationStats): string[] {
  const lines: string[] = [];
  if (o.colors) lines.push(`Cores: tom girado ${p.hue > 0 ? "+" : ""}${p.hue}° em ${stats.colors} ${stats.colors === 1 ? "cor" : "cores"} (cinzas, preto e branco ficam).`);
  if (o.fonts) {
    const f = [stats.families.sans && `${stats.families.sans} (sem serifa)`, stats.families.serif && `${stats.families.serif} (serifa)`].filter(Boolean);
    lines.push(`Fontes: ${f.join(" e ")}.`);
  }
  if (o.shape) {
    lines.push(
      `Cantos ${p.radius > 1 ? "mais arredondados" : "mais retos"} (×${p.radius}) e sombras ${p.shadow > 1 ? "mais fortes" : "mais leves"} (×${p.shadow}): ${stats.radii + stats.shadows} ajustes.`,
    );
  }
  if (o.spacing) lines.push(`Espaçamentos ${p.spacing > 1 ? "mais folgados" : "mais apertados"} (×${p.spacing}): ${stats.spacings} ajustes.`);
  return lines;
}
