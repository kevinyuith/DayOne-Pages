"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS } from "@/components/ui/field";
import { AUTO_PLACEHOLDERS, PLACEHOLDER_FIELDS, placeholderToken } from "@/lib/pages/placeholders";
import { savePlaceholders, type PlaceholdersFormState } from "../actions";

const INITIAL: PlaceholdersFormState = { attempt: 0 };

/**
 * Os dados do domínio que os marcadores {{chave}} das páginas usam. O
 * servidor troca na hora de servir: salvar aqui muda todas as páginas do
 * domínio de uma vez.
 */
export function PlaceholdersForm({ domainId, domain, values }: { domainId: string; domain: string; values: Record<string, unknown> }) {
  const [state, action, pending] = useActionState(savePlaceholders.bind(null, domainId), INITIAL);
  const value = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : "");

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold">Dados do domínio</h2>
      <p className="mt-1 text-xs text-muted">
        Nas páginas, escreva o marcador (ex.: <code className="font-mono">{"{{company_name}}"}</code>) e o domínio troca pelo valor daqui ao servir.
        Campo vazio vira texto vazio.
      </p>

      <form action={action} className="mt-4 flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {PLACEHOLDER_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={placeholderToken(f.key)}>
              <input
                name={f.key}
                defaultValue={value(f.key)}
                placeholder={f.example}
                maxLength={f.max}
                type={f.key === "email" ? "email" : "text"}
                disabled={pending}
                className={INPUT_CLASS}
              />
            </Field>
          ))}
        </div>
        <p className="text-xs text-muted">
          Automáticos:{" "}
          {AUTO_PLACEHOLDERS.map((a, i) => (
            <span key={a.key}>
              {i > 0 ? " · " : null}
              <code className="font-mono">{placeholderToken(a.key)}</code> = {a.key === "domain" ? domain : a.label.toLowerCase()}
            </span>
          ))}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Salvando…" : "Salvar dados"}
          </Button>
          {state.error ? (
            <span role="alert" className="text-xs text-red-600 dark:text-red-400">
              {state.error}
            </span>
          ) : null}
          {state.success ? (
            <span role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
              {state.success}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
