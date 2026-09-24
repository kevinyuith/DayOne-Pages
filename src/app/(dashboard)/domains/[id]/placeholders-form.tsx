"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS } from "@/components/ui/field";
import { companyName } from "@/lib/pages/company-name";
import { AUTO_PLACEHOLDERS, PLACEHOLDER_FIELDS, placeholderToken } from "@/lib/pages/placeholders";
import { savePlaceholders, type PlaceholdersFormState } from "../actions";

const INITIAL: PlaceholdersFormState = { attempt: 0 };

/**
 * The domain data used by the pages' {{key}} placeholders. The server
 * swaps them in when serving: saving here changes all of the domain's
 * pages at once.
 */
export function PlaceholdersForm({ domainId, domain, values }: { domainId: string; domain: string; values: Record<string, unknown> }) {
  const [state, action, pending] = useActionState(savePlaceholders.bind(null, domainId), INITIAL);
  const value = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : "");
  // {{company.name}} comes from the legal name; show the result while typing.
  const [legalName, setLegalName] = useState(value("company.llc"));
  const derived = companyName(legalName);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold">Domain details</h2>
      <p className="mt-1 text-xs text-muted">
        In pages, write the placeholder (e.g. <code className="font-mono">{"{{company.name}}"}</code>) and the domain swaps in the value from here when serving.
        An empty field becomes empty text. The company name is the legal name without LLC, LTDA, Inc and the like.
      </p>

      <form action={action} className="mt-4 flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {PLACEHOLDER_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              hint={
                f.key === "company.llc"
                  ? `${placeholderToken(f.key)} · ${placeholderToken("company.name")} = ${derived || "—"}`
                  : placeholderToken(f.key)
              }
            >
              <input
                name={f.key}
                defaultValue={value(f.key)}
                onChange={f.key === "company.llc" ? (e) => setLegalName(e.target.value) : undefined}
                placeholder={f.example}
                maxLength={f.max}
                type={f.key === "company.email" ? "email" : "text"}
                disabled={pending}
                className={INPUT_CLASS}
              />
            </Field>
          ))}
        </div>
        <div className="text-xs text-muted">
          <p className="mb-1 font-medium">Automatic:</p>
          <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {AUTO_PLACEHOLDERS.map((a) => (
              <li key={a.key}>
                <code className="font-mono text-foreground">{placeholderToken(a.key)}</code> —{" "}
                {a.key === "domain" ? domain : a.key === "company.name" ? derived || a.note : a.note}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save details"}
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
