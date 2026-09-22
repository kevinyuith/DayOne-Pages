"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import { PAGE_KINDS, PAGE_KIND_LABELS } from "@/lib/pages/types";
import { createPage, type CreatePageState } from "./actions";

const INITIAL: CreatePageState = { attempt: 0 };

/**
 * Formulário de nova página. `folderId` é a pasta onde ela nasce (a pasta
 * aberta na tela); em sucesso a action redireciona para a página criada.
 */
export function CreatePageForm({ folderId = null, onCancel }: { folderId?: string | null; onCancel?: () => void }) {
  const [state, action, pending] = useActionState(createPage, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-3">
      {folderId ? <input type="hidden" name="folder_id" value={folderId} /> : null}
      <Field label="Nome">
        <input name="name" required minLength={2} maxLength={120} placeholder="Ex.: Oferta principal" disabled={pending} className={INPUT_CLASS} />
      </Field>
      <Field label="Tipo">
        <select name="kind" defaultValue="OTHER" disabled={pending} className={SELECT_CLASS}>
          {PAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {PAGE_KIND_LABELS[k]}
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
          {pending ? "Criando…" : "Criar página"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancelar
          </Button>
        ) : null}
      </div>
    </form>
  );
}
