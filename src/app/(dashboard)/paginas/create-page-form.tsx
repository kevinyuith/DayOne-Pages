"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import { PAGE_KINDS, PAGE_KIND_LABELS } from "@/lib/pages/types";
import { createPage, type CreatePageState } from "./actions";

const INITIAL: CreatePageState = { attempt: 0 };

export function CreatePageForm() {
  const [state, action, pending] = useActionState(createPage, INITIAL);

  return (
    <form action={action} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field label="Nome" className="sm:flex-1">
        <input name="name" required minLength={2} maxLength={120} placeholder="Ex.: Oferta principal" disabled={pending} className={INPUT_CLASS} />
      </Field>
      <Field label="Tipo" className="sm:w-48">
        <select name="kind" defaultValue="OTHER" disabled={pending} className={SELECT_CLASS}>
          {PAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {PAGE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Criando…" : "Criar página"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400 sm:ml-2">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
