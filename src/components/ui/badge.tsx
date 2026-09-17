import type { ReactNode } from "react";
import type { DomainStatus, PageStatus } from "@/lib/pages/types";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const TONES: Record<Tone, string> = {
  neutral: "bg-foreground/5 text-muted",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "bg-red-500/10 text-red-700 dark:text-red-400",
  info: "bg-accent/10 text-accent",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}>{children}</span>
  );
}

export const PAGE_STATUS_TONE: Record<PageStatus, Tone> = { DRAFT: "warning", PUBLISHED: "success", ARCHIVED: "neutral" };
export const DOMAIN_STATUS_TONE: Record<DomainStatus, Tone> = { ACTIVE: "success", PAUSED: "warning", ARCHIVED: "neutral" };
