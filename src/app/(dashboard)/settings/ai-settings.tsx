"use client";

import { useActionState, useState } from "react";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INPUT_CLASS } from "@/components/ui/field";
import type { AiStatus } from "@/lib/ai-settings";
import { APP_TZ } from "@/lib/time-zone";
import { removeKimiKey, saveKimiKey, type AiKeyState } from "./ai-actions";

const INITIAL: AiKeyState = { attempt: 0 };
const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: APP_TZ });

/**
 * The AI that rewrites the copy in template variations (Kimi, by Moonshot AI).
 * The key stays in the system (Vault) and never comes back to this screen — only
 * the last 4 characters. The model is fixed in the code (AI_MODEL).
 */
export function AiSettings({ status }: { status: AiStatus }) {
  const [state, action, pending] = useActionState(saveKimiKey, INITIAL);
  const [replacing, setReplacing] = useState(false);

  const showForm = !status.keySet || replacing || state.error;

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

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Model:</span>
        <span className="font-mono text-xs">{status.model}</span>
      </div>
    </section>
  );
}
