"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import type { PageOption } from "@/lib/pages/queries";
import { PAGE_KIND_LABELS, PAGE_STATUS_LABELS } from "@/lib/pages/types";
import { addDomain, type DomainFormState } from "./actions";

const INITIAL: DomainFormState = { attempt: 0 };

export function DomainForm({ pages }: { pages: PageOption[] }) {
  const [state, action, pending] = useActionState(addDomain, INITIAL);

  return (
    <form action={action} key={state.success ? state.attempt : "form"} className="mt-3 flex flex-col gap-2">
      {/* A dica fica FORA da linha: com ela dentro do campo, `items-end` alinhava o select e o botão pela dica, não pelo input. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Domínio" className="min-w-0 sm:flex-1">
          <input name="domain" required placeholder="exemplo.com" disabled={pending} className={INPUT_CLASS} autoCapitalize="off" spellCheck={false} />
        </Field>
        <Field label="Página padrão" className="sm:w-64">
          <select name="default_page_id" defaultValue="" disabled={pending} className={SELECT_CLASS}>
            <option value="">— escolher depois —</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {PAGE_KIND_LABELS[p.kind]}
                {p.status !== "PUBLISHED" ? ` (${PAGE_STATUS_LABELS[p.status].toLowerCase()})` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" disabled={pending} className="sm:shrink-0">
          {pending ? "Adicionando…" : "Adicionar"}
        </Button>
      </div>
      <p className="text-xs text-muted">Sem http:// e sem www. Ex.: minhaoferta.com</p>
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
