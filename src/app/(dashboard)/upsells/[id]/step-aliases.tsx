"use client";

import { useState } from "react";
import { INPUT_CLASS } from "@/components/ui/field";
import { stepPath, type UpsellConfig, type UpsellStep } from "@/lib/pages/upsell-types";
import { MAX_ALIASES, aliasesProblem } from "@/lib/pages/vendor-paths";

type Update = (fn: (c: UpsellConfig) => void) => void;

/**
 * Where a step is served: its path, the implicit alias in the vendor page's
 * folder (/bg/up1) and its own aliases — the URLs already registered on the
 * platforms (/bg/up1v2), added and removed here (vendor-paths.ts checks them,
 * like the database).
 */
export function StepAliases({ config, step, folder, update }: { config: UpsellConfig; step: UpsellStep; folder: string; update: Update }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const own = step.aliases ?? [];
  const implicit = folder ? folder + step.slug : null;

  const add = () => {
    const alias = draft.trim().toLowerCase().replace(/\/+$/, "");
    if (!alias) return;
    const problem = aliasesProblem(
      config.steps.map((s) => ({ canonical: stepPath(s.id), aliases: s.id === step.id ? [...(s.aliases ?? []), alias] : (s.aliases ?? []) })),
    );
    if (problem) return setError(problem);
    if (alias === implicit) return setError(`${alias} is already served here (the page's folder).`);
    update((c) => {
      const s = c.steps.find((x) => x.id === step.id);
      if (s) s.aliases = [...(s.aliases ?? []), alias];
    });
    setDraft("");
    setError(null);
  };
  const remove = (alias: string) =>
    update((c) => {
      const s = c.steps.find((x) => x.id === step.id);
      if (!s) return;
      const rest = (s.aliases ?? []).filter((a) => a !== alias);
      if (rest.length) s.aliases = rest;
      else delete s.aliases;
    });

  const chip = "inline-flex min-h-8 items-center gap-1 rounded-full border border-border px-2.5 font-mono text-xs";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs font-medium text-muted">Served at</span>
        <span className={chip}>{step.slug}</span>
        {implicit ? (
          <span className={`${chip} text-muted`} title="The vendor page's folder">
            {implicit}
          </span>
        ) : null}
        {own.map((a) => (
          <span key={a} className={chip}>
            {a}
            <button type="button" aria-label={`Remove alias ${a}`} onClick={() => remove(a)} className="size-6 rounded-full text-muted hover:bg-foreground/5 hover:text-foreground">
              ×
            </button>
          </span>
        ))}
        {own.length < MAX_ALIASES ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
            className="flex items-center gap-1"
          >
            <input
              aria-label="New alias"
              value={draft}
              placeholder="/bg/up1v2"
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              className={`${INPUT_CLASS} w-40 font-mono`}
            />
            <button type="submit" disabled={!draft.trim()} className="min-h-10 px-1 text-sm font-semibold text-accent disabled:opacity-40">
              + Alias
            </button>
          </form>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
