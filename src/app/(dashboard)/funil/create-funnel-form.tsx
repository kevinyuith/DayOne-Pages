"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import { createFunnel, type CreateFunnelState } from "../paginas/actions";

const INITIAL: CreateFunnelState = { attempt: 0 };

/**
 * Nova página de um funil do dayone-main (F1, F2…): nome e, se quiser, um
 * template que vira o Lander. Nasce como rascunho com a slug `/` (Pre Lander +
 * Lander) e já ligada ao funil; as amostras do teste A/B se criam no editor,
 * que a action abre em seguida.
 */
export function CreateFunnelForm({
  funnelId,
  defaultName,
  templates,
  onCancel,
}: {
  funnelId: string | null;
  defaultName: string;
  templates: { id: string; name: string }[];
  onCancel?: () => void;
}) {
  const [state, action, pending] = useActionState(createFunnel, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      {funnelId ? <input type="hidden" name="funnel_id" value={funnelId} /> : null}
      <Field label="Page name" className="sm:flex-1">
        <input name="name" required minLength={2} maxLength={120} defaultValue={defaultName} disabled={pending} className={INPUT_CLASS} />
      </Field>
      <Field label="Lander" className="sm:w-64">
        <select name="template_id" defaultValue="" disabled={pending} className={SELECT_CLASS}>
          <option value="">Blank starter</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              Template: {t.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create page"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400 sm:basis-full">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
