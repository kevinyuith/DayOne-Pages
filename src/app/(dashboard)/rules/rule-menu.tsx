"use client";

import { useEffect, useRef, useState } from "react";
import { MoreIcon } from "@/components/icons";
import { RowAction } from "@/components/row-action";
import type { RuleMode } from "@/lib/pages/rules-types";
import { deleteRule, duplicateRule, setRuleMode } from "./actions";

/**
 * The row's secondary actions in a "⋯" popover — Monitor (or Activate, for a
 * rule in Monitor), Duplicate, Delete — so the row keeps only Edit and Pause up front.
 */
export function RuleMenu({ id, name, mode }: { id: string; name: string; mode: RuleMode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <MoreIcon className="size-4" />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-20 mt-1 flex w-40 flex-col gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
          {mode === "monitor" ? (
            <RowAction action={setRuleMode.bind(null, id, "active")} label="Activate" pendingLabel="…" variant="ghost" onDone={(r) => r.ok && setOpen(false)} />
          ) : (
            <RowAction action={setRuleMode.bind(null, id, "monitor")} label="Monitor" pendingLabel="…" variant="ghost" onDone={(r) => r.ok && setOpen(false)} />
          )}
          <RowAction action={duplicateRule.bind(null, id)} label="Duplicate" pendingLabel="…" variant="ghost" onDone={(r) => r.ok && setOpen(false)} />
          <RowAction action={deleteRule.bind(null, id)} label="Delete" pendingLabel="…" variant="danger" confirm={`Delete the rule "${name}"?`} onDone={(r) => r.ok && setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
