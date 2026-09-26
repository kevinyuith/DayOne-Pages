"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { INPUT_CLASS } from "@/components/ui/field";
import { saveGateSlugs } from "../actions";

/**
 * The domain's allowed slugs: the paths where a clean click goes to the
 * funnel of its sub1 — "/" included when it's in the list. Take "/" out to
 * keep the root on the safe page. Any slug not in the list shows the domain's
 * page at that slug (the safe page), or 404 when no page has it.
 */
export function GateSlugsForm({ domainId, slugs }: { domainId: string; slugs: string[] }) {
  const router = useRouter();
  const [text, setText] = useState(slugs.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty = text.trim() !== slugs.join(", ").trim();

  const save = () =>
    start(async () => {
      setError(null);
      setNotice(null);
      const list = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
      const r = await saveGateSlugs(domainId, list);
      if (r.ok) {
        setText(r.slugs.join(", "));
        setNotice("Saved. It takes effect on the servers within 30 s.");
        router.refresh();
      } else {
        setError(r.reason);
      }
    });

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold">Traffic gate</h2>
      <p className="mt-1 text-xs text-muted">
        The slugs where a clean click (one that passes every rule in Rules) goes to the funnel named in its sub1 ([F…] token). Any slug not in the list
        shows the domain&apos;s page at that slug. Take <code>/</code> out to keep the root on the safe page.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex min-w-64 flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-muted">Allowed slugs (comma-separated, / included when allowed)</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="/, /oferta, /obrigado"
            className={`${INPUT_CLASS} font-mono`}
            disabled={pending}
            aria-label="Allowed slugs"
          />
        </label>
        <Button size="sm" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save slugs"}
        </Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      {notice ? <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{notice}</p> : null}
    </div>
  );
}
