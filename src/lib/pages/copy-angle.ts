import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { KIMI_BASE_URL, getAiModel, getKimiKey } from "@/lib/ai-settings";

/**
 * "Template variation" with a different copy angle: rewrites the page's
 * visible text (every slug, in a single call) from the information the
 * user sent. Server-only.
 *
 * Model: Kimi (Moonshot AI, OpenAI-compatible API) when its key is configured
 * in the system (Settings → Vault, see ai-settings.ts), with the model
 * chosen there; otherwise Claude (`claude-opus-5`) when there's an
 * ANTHROPIC_API_KEY. The rules (prompt) and the checks on the way back are
 * the same for both.
 *
 * The HTML doesn't go through the model: the text is taken from between the tags
 * (outside <script>, <style>, <template>, <textarea> and comments), goes out
 * numbered, comes back numbered and goes into the same place. Structure, links
 * and styles don't change.
 *
 * A segment that comes back missing some {{placeholder}} from the original, or
 * empty, stays as it was. A page with too much text for one call is rejected
 * with a notice (text is never cut silently).
 *
 * Needs the Kimi key in Settings (or ANTHROPIC_API_KEY).
 */

const CLAUDE_MODEL = "claude-opus-5";
/** Kimi's response and reasoning count toward the same limit. */
const KIMI_MAX_TOKENS = 65536;
const KIMI_TIMEOUT_MS = 240_000;
const MAX_SEGMENTS = 1200;
const MAX_CHARS = 150_000;

const SKIP_BLOCK = /(<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<template\b[\s\S]*?<\/template\s*>|<textarea\b[\s\S]*?<\/textarea\s*>|<[^>]*>)/gi;
const TOKEN_RE = /\{\{\s*[a-z][a-z0-9_.]*\s*\}\}/gi;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", "#39": "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const encode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");

type Piece = { html: string; segment?: { id: number; lead: string; core: string; trail: string } };

/** Splits the HTML into pieces; the text pieces worth rewriting get an id. */
function splitPage(html: string, nextId: () => number): Piece[] {
  return html.split(SKIP_BLOCK).map((part, i) => {
    // split with a capture group: odd indices are the skipped tags/blocks.
    if (i % 2 === 1 || !/\p{L}[\s\S]*\p{L}/u.test(part)) return { html: part };
    const lead = part.match(/^\s*/)?.[0] ?? "";
    const trail = part.match(/\s*$/)?.[0] ?? "";
    const core = decode(part.slice(lead.length, part.length - trail.length));
    // Only a placeholder, URL or email: not copy.
    if (!core.replace(TOKEN_RE, "").match(/\p{L}{2,}/u) || /^(https?:\/\/|www\.)\S+$/i.test(core) || /^\S+@\S+\.\S+$/.test(core)) return { html: part };
    return { html: part, segment: { id: nextId(), lead, core, trail } };
  });
}

const TOKEN_KEY = (s: string) => (s.match(TOKEN_RE) ?? []).map((t) => t.replace(/\s/g, "")).sort().join("|");

/**
 * The text segments of every slug (unique ids) and how to rebuild the HTML
 * with new text. A segment with no new text, empty, or that lost a placeholder
 * stays as it was.
 */
export function extractCopySegments(pages: Record<string, string>): {
  segments: { id: number; text: string }[];
  rebuild: (texts: Map<number, string>) => { pages: Record<string, string>; rewritten: number };
} {
  let counter = 0;
  const nextId = () => ++counter;
  const split = Object.fromEntries(Object.entries(pages).map(([slug, html]) => [slug, splitPage(html, nextId)]));
  const segments = Object.values(split).flatMap((pieces) => pieces.flatMap((p) => (p.segment ? [{ id: p.segment.id, text: p.segment.core }] : [])));
  const rebuild = (texts: Map<number, string>) => {
    let rewritten = 0;
    const out: Record<string, string> = {};
    for (const [slug, pieces] of Object.entries(split)) {
      out[slug] = pieces
        .map((p) => {
          if (!p.segment) return p.html;
          const next = texts.get(p.segment.id)?.trim();
          if (!next || TOKEN_KEY(next) !== TOKEN_KEY(p.segment.core)) return p.html;
          if (next === p.segment.core) return p.html;
          rewritten++;
          return p.segment.lead + encode(next) + p.segment.trail;
        })
        .join("");
    }
    return { pages: out, rewritten };
  };
  return { segments, rebuild };
}

const OutputSchema = z.object({ segments: z.array(z.object({ id: z.number().int(), text: z.string() })) });

const JSON_SCHEMA = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["segments"],
  additionalProperties: false,
};

const SYSTEM = `You rewrite the copy of a web page (landing page, presell or advertorial) with a new angle, following the brief the user gives.

You receive the page's visible text as numbered segments, in page order. Return every segment, with the same id, rewritten for the new angle. Rules:
- Write in the page's language, even if the brief is in another language.
- Keep each segment's job: a menu item or button stays a short label; a headline stays a headline; a paragraph stays a paragraph. Keep length within about 30% of the original so the layout still fits.
- Keep unchanged: brand and product names, prices, numbers, dates, percentages, URLs, emails, phone numbers, addresses, and every {{placeholder}} token exactly as written.
- Keep legal and compliance text as it is (disclaimers, terms, privacy, copyright, cookie notices, "results may vary" notes).
- Do not invent facts, statistics, testimonials, reviews, guarantees, awards, or health, income or other claims that are not in the original. Change the angle, emphasis, framing and tone, not the facts.
- If a segment should not change (a name, a label that fits any angle), return it as it is.`;

export type CopyAngleResult = { ok: true; pages: Record<string, string>; rewritten: number } | { ok: false; reason: string };

/**
 * Rewrites the text of every slug ({slug: html}) with the requested angle.
 * Returns each slug's HTML with the new text.
 */
type Rewrite = { ok: true; texts: Map<number, string> } | { ok: false; reason: string };

const userMessage = (brief: string, segments: { id: number; text: string }[]) =>
  `Brief for the new angle:\n<brief>\n${brief}\n</brief>\n\nSegments (JSON):\n${JSON.stringify(segments)}`;

function parseOutput(text: string): Rewrite {
  try {
    const parsed = OutputSchema.parse(JSON.parse(text));
    return { ok: true, texts: new Map(parsed.segments.map((s) => [s.id, s.text])) };
  } catch {
    return { ok: false, reason: "The model's response came back in an unexpected format. Try again." };
  }
}

/** Kimi (Moonshot AI): chat completions in JSON mode. */
async function rewriteWithKimi(key: string, model: string, segments: { id: number; text: string }[], brief: string): Promise<Rewrite> {
  let res: Response;
  try {
    res = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: KIMI_MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `${SYSTEM}\n\nReply only with a JSON object: {"segments": [{"id": <number>, "text": <string>}]}, one entry for every id you received.`,
          },
          { role: "user", content: userMessage(brief, segments) },
        ],
      }),
      signal: AbortSignal.timeout(KIMI_TIMEOUT_MS),
    });
  } catch (cause) {
    const timeout = cause instanceof Error && cause.name === "TimeoutError";
    return { ok: false, reason: timeout ? "Kimi took too long to respond. Try a smaller page." : "Couldn't reach the Kimi API." };
  }
  if (res.status === 401) return { ok: false, reason: "The Kimi key was rejected. Check it in Settings." };
  if (res.status === 429) return { ok: false, reason: "Kimi API usage limit reached (or out of credit). Try again in a moment." };
  if (!res.ok) return { ok: false, reason: `The Kimi API returned an error (HTTP ${res.status}). Try again.` };

  const body = (await res.json().catch(() => null)) as { choices?: { finish_reason?: string; message?: { content?: string } }[] } | null;
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === "length") return { ok: false, reason: "The response was too long. Try a smaller page." };
  if (choice?.finish_reason === "content_filter") return { ok: false, reason: "The model declined to rewrite this page. Try another angle." };
  return parseOutput(choice?.message?.content ?? "");
}

/** Claude: streaming, structured output and server-side fallback. */
async function rewriteWithClaude(segments: { id: number; text: string }[], brief: string): Promise<Rewrite> {
  const client = new Anthropic();
  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = client.beta.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage(brief, segments) }],
      output_config: { format: { type: "json_schema", schema: JSON_SCHEMA } },
    });
    message = await stream.finalMessage();
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return { ok: false, reason: "The dashboard's ANTHROPIC_API_KEY was rejected. Check the key." };
    if (error instanceof Anthropic.RateLimitError) return { ok: false, reason: "Anthropic API usage limit reached. Try again in a moment." };
    if (error instanceof Anthropic.APIError) return { ok: false, reason: `The Anthropic API returned an error (${error.status ?? "no status"}). Try again.` };
    return { ok: false, reason: "Couldn't reach the Anthropic API." };
  }
  if (message.stop_reason === "refusal") return { ok: false, reason: "The model declined to rewrite this page. Try another angle." };
  if (message.stop_reason === "max_tokens") return { ok: false, reason: "The response was too long. Try a smaller page." };
  return parseOutput(message.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "");
}

/**
 * Rewrites the text of every slug ({slug: html}) with the requested angle.
 * Returns each slug's HTML with the new text.
 */
export async function rewriteCopyAngle(pages: Record<string, string>, brief: string): Promise<CopyAngleResult> {
  const kimiKey = await getKimiKey();
  const claude = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!kimiKey && !claude) {
    return { ok: false, reason: "To rewrite the copy, add the Kimi key in Settings. The visual variation works without it." };
  }

  const { segments, rebuild } = extractCopySegments(pages);
  if (segments.length === 0) return { ok: false, reason: "Couldn't find any text to rewrite on this page." };
  const chars = segments.reduce((n, s) => n + s.text.length, 0);
  if (segments.length > MAX_SEGMENTS || chars > MAX_CHARS) {
    return { ok: false, reason: `The page has too much text to rewrite in one go (${segments.length} segments, ${chars} characters). Generate only the visual variation.` };
  }

  const r = kimiKey ? await rewriteWithKimi(kimiKey, await getAiModel(), segments, brief) : await rewriteWithClaude(segments, brief);
  if (!r.ok) return r;
  const { pages: out, rewritten } = rebuild(r.texts);
  return { ok: true, pages: out, rewritten };
}
