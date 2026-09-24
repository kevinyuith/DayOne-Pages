"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import type { TemplateOption } from "@/lib/pages/queries";
import { PAGE_KIND_LABELS } from "@/lib/pages/types";
import { addDomain, type DomainFormState } from "./actions";

const INITIAL: DomainFormState = { attempt: 0 };

export function DomainForm({ templates }: { templates: TemplateOption[] }) {
  const [state, action, pending] = useActionState(addDomain, INITIAL);

  return (
    <form action={action} key={state.success ? state.attempt : "form"} className="mt-3 flex flex-col gap-2">
      {/* A dica fica FORA da linha: com ela dentro do campo, `items-end` alinhava o select e o botão pela dica, não pelo input. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Domain" className="min-w-0 sm:flex-1">
          <input name="domain" required placeholder="example.com" disabled={pending} className={INPUT_CLASS} autoCapitalize="off" spellCheck={false} />
        </Field>
        <Field label="Template (becomes the domain page)" className="sm:w-64">
          <select name="template_id" defaultValue="" disabled={pending} className={SELECT_CLASS}>
            <option value="">— choose later —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {PAGE_KIND_LABELS[t.kind]}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" disabled={pending} className="sm:shrink-0">
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      <p className="text-xs text-muted">No http:// and no www. E.g. myoffer.com</p>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {state.success}
        </p>
      ) : null}
    </form>
  );
}
