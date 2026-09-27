import Anthropic from "@anthropic-ai/sdk";
import { AI_MODEL, KIMI_BASE_URL, getKimiKey } from "@/lib/ai-settings";

/**
 * "Edit with AI" in the editor's Code panel: the person describes a change and
 * the model returns the whole edited HTML (the panel's HTML, without the CSS)
 * or the whole edited Page CSS. Server-only.
 *
 * Same models and keys as the copy angle (copy-angle.ts): Kimi when its key is
 * in Settings, otherwise Claude (`claude-opus-5`) when there is an
 * ANTHROPIC_API_KEY. The result goes back into the panel's editor; nothing is
 * saved here.
 *
 * For CSS, the page's HTML goes along as read-only context (so the selectors
 * match the page), when it fits.
 */

export type CodeKind = "html" | "css";

const CLAUDE_MODEL = "claude-opus-5";
/** Kimi's response and reasoning count toward the same limit. */
const KIMI_MAX_TOKENS = 65536;
const KIMI_TIMEOUT_MS = 240_000;
/** A page this big wouldn't come back whole in one response. */
export const CODE_AI_MAX_CHARS = 120_000;
/** The HTML sent as context for a CSS edit is dropped above this. */
const CONTEXT_MAX_CHARS = 80_000;
export const CODE_AI_MAX_INSTRUCTIONS = 4000;

const RULES = `- Change only what the instructions ask for. Everything else stays exactly as it is, character for character.
- Keep every {{placeholder}} token exactly as written.
- Do not invent facts, prices, testimonials, reviews, guarantees, or health, income or other claims.
- Reply with the complete result only: no explanations, no notes, no Markdown code fences.`;

const SYSTEM: Record<CodeKind, string> = {
  html: `You edit the HTML of a web page (landing page, presell or advertorial) following the user's instructions. You receive the whole document and return the whole edited document.
- Keep ids, classes, data-* attributes (data-dop-*, data-href and the rest), scripts, links and forms unless the instructions are about them.
- The page's CSS lives elsewhere: every <style> element whose only content is a comment like /* Base CSS #1 */ must stay exactly where and as it is. Use inline style attributes only if the instructions ask for them.
${RULES}`,
  css: `You edit a web page's own stylesheet (it comes after the page's other CSS, so its rules win ties) following the user's instructions. You receive the stylesheet — possibly empty — and, for reference, the page's HTML. Return the whole edited stylesheet (plain CSS, no <style> tag).
- Write selectors that match the page's HTML. Do not return HTML.
${RULES}`,
};

export type CodeAiResult = { ok: true; code: string } | { ok: false; reason: string };

function userMessage(kind: CodeKind, code: string, instructions: string, context: string | null): string {
  const label = kind === "html" ? "HTML" : "CSS";
  const page = context ? `\n\nThe page's HTML (reference only, do not return it):\n<page>\n${context}\n</page>` : "";
  return `Instructions:\n<instructions>\n${instructions}\n</instructions>${page}\n\nCurrent ${label}:\n<code>\n${code}\n</code>`;
}

/** Drops a Markdown fence around the whole answer, in case the model added one. */
function unfence(text: string): string {
  const m = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : text;
}

async function editWithKimi(key: string, system: string, user: string): Promise<CodeAiResult> {
  let res: Response;
  try {
    res = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: KIMI_MAX_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(KIMI_TIMEOUT_MS),
    });
  } catch (cause) {
    const timeout = cause instanceof Error && cause.name === "TimeoutError";
    return { ok: false, reason: timeout ? "Kimi took too long to respond. Try a smaller change." : "Couldn't reach the Kimi API." };
  }
  if (res.status === 401) return { ok: false, reason: "The Kimi key was rejected. Check it in Settings." };
  if (res.status === 429) return { ok: false, reason: "Kimi API usage limit reached (or out of credit). Try again in a moment." };
  if (!res.ok) return { ok: false, reason: `The Kimi API returned an error (HTTP ${res.status}). Try again.` };

  const body = (await res.json().catch(() => null)) as { choices?: { finish_reason?: string; message?: { content?: string } }[] } | null;
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === "length") return { ok: false, reason: "The result was too long to come back whole. Try on a smaller page." };
  if (choice?.finish_reason === "content_filter") return { ok: false, reason: "The model declined this change." };
  const text = choice?.message?.content ?? "";
  return text.trim() ? { ok: true, code: unfence(text) } : { ok: false, reason: "The model returned nothing. Try again." };
}

async function editWithClaude(system: string, user: string): Promise<CodeAiResult> {
  const client = new Anthropic();
  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = client.beta.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: user }],
    });
    message = await stream.finalMessage();
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return { ok: false, reason: "The dashboard's ANTHROPIC_API_KEY was rejected. Check the key." };
    if (error instanceof Anthropic.RateLimitError) return { ok: false, reason: "Anthropic API usage limit reached. Try again in a moment." };
    if (error instanceof Anthropic.APIError) return { ok: false, reason: `The Anthropic API returned an error (${error.status ?? "no status"}). Try again.` };
    return { ok: false, reason: "Couldn't reach the Anthropic API." };
  }
  if (message.stop_reason === "refusal") return { ok: false, reason: "The model declined this change." };
  if (message.stop_reason === "max_tokens") return { ok: false, reason: "The result was too long to come back whole. Try on a smaller page." };
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text.trim() ? { ok: true, code: unfence(text) } : { ok: false, reason: "The model returned nothing. Try again." };
}

/** Edits `code` (the panel's HTML or Page CSS) as `instructions` say; `context` = the page's HTML, for CSS. */
export async function editCodeWithAi(kind: CodeKind, code: string, instructions: string, context: string | null): Promise<CodeAiResult> {
  const kimiKey = await getKimiKey();
  const claude = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!kimiKey && !claude) return { ok: false, reason: "To edit with AI, add the Kimi key in Settings." };
  if (code.length > CODE_AI_MAX_CHARS) {
    return { ok: false, reason: `This ${kind === "html" ? "HTML" : "CSS"} is too big to edit with AI in one go (${code.length.toLocaleString("en-US")} characters).` };
  }
  const page = kind === "css" && context && context.length <= CONTEXT_MAX_CHARS ? context : null;
  const user = userMessage(kind, code, instructions, page);
  return kimiKey ? editWithKimi(kimiKey, SYSTEM[kind], user) : editWithClaude(SYSTEM[kind], user);
}
