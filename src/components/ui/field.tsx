import type { ReactNode } from "react";

/** Classes dos controles, num lugar só. `*_BASE` sem largura, para quem precisa fixar a própria. */
export const INPUT_BASE =
  "h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-accent disabled:opacity-60";
export const INPUT_CLASS = `${INPUT_BASE} w-full`;
export const SELECT_BASE = `${INPUT_BASE} pr-8`;
export const SELECT_CLASS = `${SELECT_BASE} w-full`;
export const TEXTAREA_CLASS =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60";
export const CHECKBOX_CLASS = "size-4 rounded border-border accent-accent";

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      {!error && hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
