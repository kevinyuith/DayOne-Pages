import type { ReactNode } from "react";

type Tone = "info" | "warning" | "danger" | "success";

const TONES: Record<Tone, string> = {
  info: "border-accent/30 bg-accent/5 text-foreground",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  danger: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
};

export function Alert({ tone = "info", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${TONES[tone]} ${className}`}>
      {children}
    </div>
  );
}
