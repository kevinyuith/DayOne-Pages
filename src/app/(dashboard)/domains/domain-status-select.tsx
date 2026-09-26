"use client";

import { useState, useTransition } from "react";
import { SELECT_CLASS } from "@/components/ui/field";
import { DOMAIN_STATUSES, DOMAIN_STATUS_LABELS, type DomainStatus } from "@/lib/pages/types";
import { setDomainStatus } from "./actions";

/**
 * The domain's serving status (pages.domains.status): Active (the gate as
 * configured), Disabled (404 for every slug), Locked (the rules run, but no
 * slug goes to the funnel — always the domain's page) or Unlocked (the rules
 * are ignored and every slug goes straight to the sub1's funnel). Saves
 * immediately, like the type select.
 */
export function DomainStatusSelect({ domainId, value, showLabel = true }: { domainId: string; value: DomainStatus; showLabel?: boolean }) {
  const [status, setStatus] = useState<DomainStatus>(value);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        {showLabel ? <span className="text-muted">Status</span> : null}
        <select
          value={status}
          disabled={pending}
          aria-label="Domain status"
          className={`${SELECT_CLASS} h-8 w-36 text-sm`}
          onChange={(e) => {
            const next = e.target.value as DomainStatus;
            const before = status;
            setStatus(next);
            start(async () => {
              const r = await setDomainStatus(domainId, next);
              if (r.ok) {
                setError(null);
              } else {
                setStatus(before); // revert the UI if the save failed
                setError(r.reason);
              }
            });
          }}
        >
          {DOMAIN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DOMAIN_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}
