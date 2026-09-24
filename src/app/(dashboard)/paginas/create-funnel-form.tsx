"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import { createFunnel, type CreateFunnelState } from "./actions";

const INITIAL: CreateFunnelState = { attempt: 0 };

/**
 * "Criar funil": nome e, se quiser, um template que vira o Lander. Nasce como
 * rascunho com a slug `/` (Pre Lander + Lander); as amostras do teste A/B são
 * criadas no editor, no painel Funil. Em sucesso a action abre o funil.
 */
export function CreateFunnelForm({ folderId, templates, onCancel }: { folderId: string | null; templates: { id: string; name: string }[]; onCancel?: () => void }) {
  const [state, action, pending] = useActionState(createFunnel, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3">
      {folderId ? <input type="hidden" name="folder_id" value={folderId} /> : null}
      <Field label="Funnel name">
        <input name="name" required minLength={2} maxLength={120} placeholder="E.g. US supplement — news → VSL" disabled={pending} className={INPUT_CLASS} />
      </Field>
      <Field label="Lander" hint="The Pre Lander starts with a simple starter; the Backredirect stays inactive until you activate it.">
        <select name="template_id" defaultValue="" disabled={pending} className={SELECT_CLASS}>
          <option value="">Blank starter</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              Template: {t.name}
            </option>
          ))}
        </select>
      </Field>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      <div className="mt-1 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create funnel"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
