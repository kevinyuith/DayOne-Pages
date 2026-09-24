"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "@/components/icons";

/**
 * Diálogo modal mínimo: overlay, Escape fecha, clique fora fecha, foco no
 * primeiro campo. Sem biblioteca — o painel não precisa de mais que isso.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  className = "",
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Foca o primeiro controle editável, senão o painel.
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])");
    (first ?? panel.current)?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={`w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-lg outline-none ${className}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          <button type="button" data-close onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:bg-foreground/5 hover:text-foreground">
            <CloseIcon className="size-4" />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
