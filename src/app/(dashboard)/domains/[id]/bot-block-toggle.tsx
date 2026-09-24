"use client";

import { useState, useTransition } from "react";
import { CHECKBOX_CLASS } from "@/components/ui/field";
import { setBotBlock } from "../actions";

/**
 * The domain's "block bots/suspicious connections" switch. Saves immediately,
 * like the default page select. Independent of the filter: it blocks (403),
 * never swaps the page.
 */
export function BotBlockToggle({ domainId, value }: { domainId: string; value: boolean }) {
  const [on, setOn] = useState(value);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={pending}
          className={CHECKBOX_CLASS}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            start(async () => {
              const r = await setBotBlock(domainId, next);
              if (r.ok) {
                setError(null);
              } else {
                setOn(!next); // revert the UI if the save failed
                setError(r.reason);
              }
            });
          }}
        />
        Block bots and suspicious connections
      </label>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}
