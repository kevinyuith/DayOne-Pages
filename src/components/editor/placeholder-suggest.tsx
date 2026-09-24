"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from "react";
import { insertPlaceholder, openPlaceholderAt, placeholderToken, suggestPlaceholders, type PlaceholderOption } from "@/lib/pages/placeholders";

/**
 * Placeholder autocomplete in the editor: typing "{{" shows the placeholder
 * list right below; arrows choose, Enter/Tab insert, Esc closes.
 * `PlaceholderList` is just the list (the canvas positions it at the caret);
 * `PlaceholderField` is an input/textarea with the list below it (inspector).
 * Code mode uses CodeMirror's own autocomplete (code-editor.tsx).
 */

/** Key pressed with the list open: new index, "pick", "close" or null (the key proceeds normally). */
export function suggestKey(key: string, index: number, count: number): number | "pick" | "close" | null {
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Enter" || key === "Tab") return "pick";
  if (key === "Escape") return "close";
  return null;
}

export function PlaceholderList({
  items,
  index,
  values,
  onPick,
  onHover,
  className = "w-72",
}: {
  items: PlaceholderOption[];
  index: number;
  /** Domain page: shows the value that goes in its place. Template: null, shows the name. */
  values: Record<string, string> | null;
  onPick: (key: string) => void;
  onHover: (index: number) => void;
  className?: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <ul ref={listRef} role="listbox" aria-label="Placeholders" className={`max-h-56 overflow-auto rounded-lg border border-border bg-surface p-1 text-xs text-foreground shadow-lg ${className}`}>
      {items.map((o, i) => (
        <li
          key={o.key}
          role="option"
          aria-selected={i === index}
          // mousedown, not click: does not take focus away from what is being edited.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(o.key);
          }}
          onMouseEnter={() => onHover(i)}
          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${i === index ? "bg-accent/10" : ""}`}
        >
          <span className="shrink-0 font-mono text-accent">{placeholderToken(o.key)}</span>
          <span className="min-w-0 flex-1 truncate text-right text-muted" title={values ? values[o.key] : o.hint}>
            {values ? values[o.key] || "(empty)" : o.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

type Open = { from: number; caret: number; items: PlaceholderOption[]; index: number };
type FieldEl = HTMLInputElement | HTMLTextAreaElement;

/** Input (or textarea) with the placeholder list when typing "{{". */
export function PlaceholderField({
  as = "input",
  value,
  onValueChange,
  onBlur,
  onKeyDown,
  values = null,
  className,
  rows,
  placeholder,
}: {
  as?: "input" | "textarea";
  value: string;
  onValueChange: (value: string) => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<FieldEl>) => void;
  values?: Record<string, string> | null;
  className?: string;
  rows?: number;
  placeholder?: string;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const ref = useRef<FieldEl>(null);

  const refresh = (el: FieldEl) => {
    const caret = el.selectionStart ?? el.value.length;
    const at = el.selectionEnd === caret ? openPlaceholderAt(el.value.slice(0, caret)) : null;
    const items = at ? suggestPlaceholders(at.query) : [];
    setOpen(at && items.length ? { from: at.from, caret, items, index: 0 } : null);
  };

  const pick = (key: string) => {
    const el = ref.current;
    if (!el || !open) return;
    const r = insertPlaceholder(el.value, open.from, open.caret, key);
    onValueChange(r.text);
    setOpen(null);
    requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret));
  };

  const common = {
    value,
    placeholder,
    className,
    onChange: (e: ChangeEvent<FieldEl>) => {
      onValueChange(e.target.value);
      refresh(e.target);
    },
    onSelect: (e: SyntheticEvent<FieldEl>) => refresh(e.currentTarget),
    onKeyDown: (e: KeyboardEvent<FieldEl>) => {
      if (open) {
        const k = suggestKey(e.key, open.index, open.items.length);
        if (k !== null) {
          e.preventDefault();
          if (k === "pick") pick(open.items[open.index].key);
          else if (k === "close") setOpen(null);
          else setOpen({ ...open, index: k });
          return;
        }
      }
      onKeyDown?.(e);
    },
    onBlur: () => {
      setOpen(null);
      onBlur?.();
    },
  };

  return (
    <div className="relative">
      {as === "textarea" ? <textarea ref={ref as RefObject<HTMLTextAreaElement>} rows={rows} {...common} /> : <input ref={ref as RefObject<HTMLInputElement>} {...common} />}
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1">
          <PlaceholderList items={open.items} index={open.index} values={values} onPick={pick} onHover={(i) => setOpen({ ...open, index: i })} className="w-full" />
        </div>
      ) : null}
    </div>
  );
}
