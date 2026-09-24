import { supabaseService } from "@/lib/supabase/service";

/**
 * Configuração da IA que reescreve a copy nas variações de template (Kimi,
 * da Moonshot AI) — no sistema, não em arquivo .env:
 *
 * - a chave fica criptografada no Supabase Vault (pages.ai_secret_*); o
 *   painel só a lê no servidor, na hora de chamar a API, e a tela recebe
 *   no máximo os 4 últimos caracteres;
 * - o modelo fica em pages.app_settings (`ai.model`).
 *
 * Editado em Configurações. Só no servidor.
 */

const KIMI_SECRET = "dayone_pages.moonshot_api_key";
export const DEFAULT_AI_MODEL = "kimi-k3";
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

export async function getAiModel(): Promise<string> {
  const { data, error } = await supabaseService().from("app_settings").select("value").eq("key", "ai.model").maybeSingle();
  if (error) throw new Error(`app_settings: ${error.message}`);
  const value = (data as { value: unknown } | null)?.value;
  return typeof value === "string" && value ? value : DEFAULT_AI_MODEL;
}

export async function setAiModel(model: string): Promise<void> {
  const { error } = await supabaseService()
    .from("app_settings")
    .upsert({ key: "ai.model", value: model, updated_at: new Date().toISOString() });
  if (error) throw new Error(`app_settings: ${error.message}`);
}

export async function getAiStatus(): Promise<AiStatus> {
  const [status, model] = await Promise.all([supabaseService().rpc("ai_secret_status", { p_name: KIMI_SECRET }), getAiModel()]);
  if (status.error) throw new Error(`ai_secret_status: ${status.error.message}`);
  const row = (status.data as { hint: string; updated_at: string }[] | null)?.[0];
  return { keySet: !!row, hint: row?.hint ?? null, updatedAt: row?.updated_at ?? null, model };
}

/** Os modelos que a chave libera (GET /models da Moonshot), do mais novo para o mais antigo. */
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
