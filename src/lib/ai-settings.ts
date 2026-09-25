import { supabaseService } from "@/lib/supabase/service";

/**
 * Settings for the AI that rewrites the copy in template variations (Kimi,
 * from Moonshot AI) — stored in the system, not in a .env file:
 *
 * - the key is encrypted in Supabase Vault (pages.ai_secret_*); the
 *   dashboard only reads it on the server, when calling the API, and the
 *   screen gets at most the last 4 characters;
 * - the model is fixed in the code (AI_MODEL).
 *
 * The key is edited in Settings. Server-only.
 */

const KIMI_SECRET = "dayone_pages.moonshot_api_key";
/** The Kimi model the copy rewriting uses. */
export const AI_MODEL = "kimi-k3";
export const KIMI_BASE_URL = "https://api.moonshot.ai/v1";

export type AiStatus = { keySet: boolean; hint: string | null; updatedAt: string | null; model: string };

export async function getKimiKey(): Promise<string | null> {
  const { data, error } = await supabaseService().rpc("ai_secret_get", { p_name: KIMI_SECRET });
  if (error) throw new Error(`ai_secret_get: ${error.message}`);
  return typeof data === "string" && data ? data : null;
}

export async function setKimiKey(key: string | null): Promise<void> {
  const { error } = await supabaseService().rpc("ai_secret_set", { p_name: KIMI_SECRET, p_secret: key });
  if (error) throw new Error(`ai_secret_set: ${error.message}`);
}

export async function getAiStatus(): Promise<AiStatus> {
  const status = await supabaseService().rpc("ai_secret_status", { p_name: KIMI_SECRET });
  if (status.error) throw new Error(`ai_secret_status: ${status.error.message}`);
  const row = (status.data as { hint: string; updated_at: string }[] | null)?.[0];
  return { keySet: !!row, hint: row?.hint ?? null, updatedAt: row?.updated_at ?? null, model: AI_MODEL };
}

/** The models the key unlocks (Moonshot's GET /models), newest to oldest. */
export async function listKimiModels(key: string): Promise<{ ok: true; models: string[] } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(`${KIMI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { ok: false, reason: "Couldn't reach the Kimi API." };
  }
  if (res.status === 401) return { ok: false, reason: "Moonshot rejected the key." };
  if (!res.ok) return { ok: false, reason: `The Kimi API returned HTTP ${res.status}.` };
  const body = (await res.json().catch(() => null)) as { data?: { id?: string; created?: number }[] } | null;
  const models = (body?.data ?? [])
    .filter((m): m is { id: string; created?: number } => typeof m.id === "string")
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
    .map((m) => m.id);
  return { ok: true, models };
}
