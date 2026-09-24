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
const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

/**
 * The AI that rewrites the copy in template variations (Kimi, by Moonshot AI).
 * The key stays in the system (Vault) and never comes back to this screen — only
 * the last 4 characters. The model comes from the list the key itself unlocks.
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
      <h2 className="text-sm font-semibold">AI for template variations</h2>
      <p className="mt-1 text-xs text-muted">
        Rewrites the copy when you generate a variation with a &ldquo;copy angle&rdquo; (Domains → Copy template → Visual variation). Uses Kimi, by
        Moonshot AI. The key is stored encrypted in the system and is not shown here again.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Kimi key:</span>
        {status.keySet ? (
          <>
            <Badge tone="success">configured</Badge>
            <span className="font-mono text-xs text-muted">ends in …{status.hint}</span>
            {status.updatedAt ? <span className="text-xs text-muted">· updated {dateFmt.format(new Date(status.updatedAt))}</span> : null}
            {!replacing ? (
              <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
                Replace key
              </Button>
            ) : null}
            <RowAction action={removeKimiKey} label="Remove" variant="danger" confirm="Remove the Kimi key? Copy rewriting stops working until you add another one." />
          </>
        ) : (
          <Badge tone="warning">not configured</Badge>
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
            {pending ? "Checking…" : "Save key"}
          </Button>
          {replacing ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(false)} disabled={pending}>
              Cancel
            </Button>
          ) : null}
        </form>
      ) : null}
      {state.error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
      {state.success ? <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{state.success}</p> : null}

      {status.keySet ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Model:</span>
          <select
            value={model}
            onChange={(e) => {
              const next = e.target.value;
              setModel(next);
              setModelMsg(null);
              startSaving(async () => {
                const r = await saveAiModel(next);
                setModelMsg(r.ok ? "Saved." : r.reason);
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
          {!models && !modelsError ? <span className="text-xs text-muted">loading the models for this key…</span> : null}
          {modelsError ? <span className="text-xs text-red-600 dark:text-red-400">{modelsError}</span> : null}
          {modelMsg ? <span className="text-xs text-muted">{modelMsg}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
