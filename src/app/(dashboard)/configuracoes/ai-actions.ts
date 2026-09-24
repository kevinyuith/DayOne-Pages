"use server";

import { revalidatePath } from "next/cache";
import { errorReason, fail, type ActionResult } from "@/lib/action-result";
import { getKimiKey, listKimiModels, setAiModel, setKimiKey } from "@/lib/ai-settings";

/**
 * Configurações → IA das variações de template. A chave vai para o Vault e
 * nunca volta para o navegador (ver ai-settings.ts).
 */

export type AiKeyState = { error?: string; success?: string; attempt: number };

/** Grava a chave do Kimi — só depois de a Moonshot aceitar (GET /models). */
export async function saveKimiKey(prev: AiKeyState, fd: FormData): Promise<AiKeyState> {
  const attempt = prev.attempt + 1;
  const key = String(fd.get("key") ?? "").trim();
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return { error: "Cole a chave da Moonshot (começa com sk-).", attempt };
  const check = await listKimiModels(key);
  if (!check.ok) return { error: check.reason, attempt };
  try {
    await setKimiKey(key);
  } catch (cause) {
    return { error: errorReason(cause), attempt };
  }
  revalidatePath("/configuracoes");
  return { success: `Chave salva. ${check.models.length} ${check.models.length === 1 ? "modelo liberado" : "modelos liberados"}.`, attempt };
}

export async function removeKimiKey(): Promise<ActionResult> {
  try {
    await setKimiKey(null);
    revalidatePath("/configuracoes");
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

/** Os modelos que a chave salva libera. */
export async function loadKimiModels(): Promise<ActionResult<{ models: string[] }>> {
  try {
    const key = await getKimiKey();
    if (!key) return fail("Nenhuma chave configurada.");
    const r = await listKimiModels(key);
    return r.ok ? { ok: true, models: r.models } : fail(r.reason);
  } catch (cause) {
    return fail(errorReason(cause));
  }
}

export async function saveAiModel(model: string): Promise<ActionResult> {
  if (!/^[A-Za-z0-9._-]{2,80}$/.test(model)) return fail("Modelo inválido.");
  try {
    await setAiModel(model);
    revalidatePath("/configuracoes");
    return { ok: true };
  } catch (cause) {
    return fail(errorReason(cause));
  }
}
