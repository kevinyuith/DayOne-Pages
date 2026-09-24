"use client";

import { useState, useTransition } from "react";
import { SELECT_CLASS } from "@/components/ui/field";
import { DOMAIN_TYPES, DOMAIN_TYPE_LABELS, type DomainType } from "@/lib/pages/types";
import { setDomainType } from "../actions";

/** The domain's type (Media Buyer / Vendor). Saves immediately, like the bot switch. */
export function DomainTypeSelect({ domainId, value }: { domainId: string; value: DomainType | null }) {
  const [type, setType] = useState<DomainType | "">(value ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted">Type</span>
        <select
          value={type}
          disabled={pending}
          aria-label="Domain type"
          className={`${SELECT_CLASS} h-8 w-40 text-sm`}
          onChange={(e) => {
            const next = e.target.value as DomainType;
            const before = type;
            setType(next);
            start(async () => {
              const r = await setDomainType(domainId, next);
              if (r.ok) {
                setError(null);
              } else {
                setType(before); // revert the UI if the save failed
                setError(r.reason);
              }
            });
          }}
        >
          {type === "" ? (
            <option value="" disabled>
              Choose…
            </option>
          ) : null}
          {DOMAIN_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOMAIN_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}
