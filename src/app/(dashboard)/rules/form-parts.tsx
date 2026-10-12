"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** A URL parameter row: "contains"/"not equals"/"absent or equals" is a `param` (one per condition object); the others go into `query`. */
export type ParamRowMode = "present" | "absent" | "empty" | "equals" | "not_equals" | "absent_or_equals" | "contains";
export const PARAM_ROW_MODES: ParamRowMode[] = ["present", "absent", "empty", "equals", "not_equals", "absent_or_equals", "contains"];
export const PARAM_ROW_LABELS: Record<ParamRowMode, string> = {
  present: "present",
  absent: "absent",
  empty: "absent or empty",
  equals: "equals",
  not_equals: "not equals",
  absent_or_equals: "absent or equals",
  contains: "contains",
};
/** Modes that post as a `param` (the rest go into `query`). */
export const PARAM_AS_PARAM: ReadonlySet<ParamRowMode> = new Set(["contains", "not_equals", "absent_or_equals"]);

/**
 * The "+ Add …" button of the conditions and exceptions lists: a small menu
 * of the kinds still available; a click outside or Escape closes it.
 */
export function AddMenu<T extends string>({
  label,
  items,
  onPick,
  disabled,
}: {
  label: string;
  items: { type: T; label: string }[];
  onPick: (type: T) => void;
  disabled: boolean;
}) {
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
    <div ref={ref} className="relative mt-2">
      <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} disabled={disabled || items.length === 0} aria-expanded={open}>
        {label}
      </Button>
      {open ? (
        <ul
          role="menu"
          className="absolute bottom-full left-0 z-10 mb-1 w-56 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {items.map((c) => (
            <li key={c.type}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onPick(c.type);
                  setOpen(false);
                }}
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-foreground/5"
              >
                {c.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
