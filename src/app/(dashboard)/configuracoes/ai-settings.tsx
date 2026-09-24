"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import type { AiStatus } from "@/lib/ai-settings";
import { APP_TZ } from "@/lib/time-zone";
import { loadKimiModels, removeKimiKey, saveAiModel, saveKimiKey, type AiKeyState } from "./ai-actions";

const INITIAL: AiKeyState = { attempt: 0 };
const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

/**
 * A IA que reescreve a copy nas variações de template (Kimi, da Moonshot AI).
 * A chave fica no sistema (Vault), nunca volta para esta tela — só os 4
 * últimos caracteres. O modelo sai da lista que a própria chave libera.
 */
export function AiSettings({ status }: { status: AiStatus }) {
  const [state, action, pending] = useActionState(saveKimiKey, INITIAL);
  const [replacing, setReplacing] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState(status.model);
  const [saving, startSaving] = useTransition();
  const [modelMsg, setModelMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!status.keySet) return;
    let alive = true;
    loadKimiModels().then((r) => {
      if (!alive) return;
      if (r.ok) setModels(r.models);
      else setModelsError(r.reason);
    });
    return () => {
      alive = false;
    };
  }, [status.keySet, status.hint]);

  const showForm = !status.keySet || replacing || state.error;
  const options = models && !models.includes(model) ? [model, ...models] : (models ?? [model]);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold">IA para variações de template</h2>
      <p className="mt-1 text-xs text-muted">
        Reescreve a copy quando você gera uma variação com &ldquo;ângulo da copy&rdquo; (Domínios → Copiar template → Variação visual). Usa o Kimi, da
        Moonshot AI. A chave fica guardada criptografada no sistema e não aparece de novo aqui.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Chave do Kimi:</span>
        {status.keySet ? (
          <>
            <Badge tone="success">configurada</Badge>
            <span className="font-mono text-xs text-muted">termina em …{status.hint}</span>
            {status.updatedAt ? <span className="text-xs text-muted">· atualizada em {dateFmt.format(new Date(status.updatedAt))}</span> : null}
            {!replacing ? (
              <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
                Trocar chave
              </Button>
            ) : null}
            <RowAction action={removeKimiKey} label="Remover" variant="danger" confirm="Remover a chave do Kimi? A reescrita da copy para de funcionar até cadastrar outra." />
          </>
        ) : (
          <Badge tone="warning">não configurada</Badge>
        )}
      </div>

      {showForm ? (
        <form action={action} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            name="key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            disabled={pending}
            className={`${INPUT_CLASS} font-mono sm:max-w-md`}
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Conferindo…" : "Salvar chave"}
          </Button>
          {replacing ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(false)} disabled={pending}>
              Cancelar
            </Button>
          ) : null}
        </form>
      ) : null}
      {state.error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
      {state.success ? <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{state.success}</p> : null}

      {status.keySet ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Modelo:</span>
          <select
            value={model}
            onChange={(e) => {
              const next = e.target.value;
              setModel(next);
              setModelMsg(null);
              startSaving(async () => {
                const r = await saveAiModel(next);
                setModelMsg(r.ok ? "Salvo." : r.reason);
              });
            }}
            disabled={saving || !models}
            className={`${SELECT_CLASS} sm:max-w-xs`}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {!models && !modelsError ? <span className="text-xs text-muted">buscando os modelos da chave…</span> : null}
          {modelsError ? <span className="text-xs text-red-600 dark:text-red-400">{modelsError}</span> : null}
          {modelMsg ? <span className="text-xs text-muted">{modelMsg}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
