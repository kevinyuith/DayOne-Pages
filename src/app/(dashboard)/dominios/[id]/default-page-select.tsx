"use client";

import { useState, useTransition } from "react";
import { SELECT_CLASS } from "@/components/ui/field";
import type { PageOption } from "@/lib/pages/queries";
import { PAGE_KIND_LABELS, PAGE_STATUS_LABELS } from "@/lib/pages/types";
import { setDefaultPage } from "../actions";

export function DefaultPageSelect({ domainId, value, pages }: { domainId: string; value: string | null; pages: PageOption[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <select
        defaultValue={value ?? ""}
        disabled={pending}
        className={SELECT_CLASS}
        onChange={(e) => {
          const next = e.target.value || null;
          start(async () => {
            const r = await setDefaultPage(domainId, next);
            setError(r.ok ? null : r.reason);
          });
        }}
      >
        <option value="">— nenhuma (404) —</option>
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {PAGE_KIND_LABELS[p.kind]}
            {p.status !== "PUBLISHED" ? ` (${PAGE_STATUS_LABELS[p.status].toLowerCase()})` : ""}
          </option>
        ))}
      </select>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}
