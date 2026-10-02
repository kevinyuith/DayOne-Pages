"use client";

import { useEffect, useRef, useState } from "react";
import { MoreIcon } from "@/components/icons";
import { RowAction } from "@/components/row-action";
import { deleteRule, duplicateRule } from "./actions";

/** The row's secondary actions (Duplicate, Delete) in a "⋯" popover, so the row keeps only Edit and Pause up front. */
export function RuleMenu({ id, name }: { id: string; name: string }) {
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
          <RowAction action={duplicateRule.bind(null, id)} label="Duplicate" pendingLabel="…" variant="ghost" onDone={(r) => r.ok && setOpen(false)} />
          <RowAction action={deleteRule.bind(null, id)} label="Delete" pendingLabel="…" variant="danger" confirm={`Delete the rule "${name}"?`} onDone={(r) => r.ok && setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
