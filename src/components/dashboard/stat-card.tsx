import type { ComponentType, ReactNode, SVGProps } from "react";

export type StatTone = "blue" | "green" | "red" | "amber" | "purple";

const TONES: Record<StatTone, string> = {
  blue: "bg-accent/10 text-accent",
  green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  red: "bg-red-500/10 text-red-600 dark:text-red-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  purple: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

/**
 * Um card de métrica do dashboard. `soon` deixa o card em estado de espera
 * (valor "—" e selo), para não mostrar número que ainda não é coletado.
 */
export function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
  soon = false,
}: {
  label: string;
  value?: ReactNode;
  detail?: ReactNode;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: StatTone;
  soon?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted">{label}</p>
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}>
          <Icon className="size-[18px]" />
        </span>
      </div>

      {soon ? (
        <>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-muted/40">—</p>
          <span className="mt-2 inline-flex items-center rounded-md bg-foreground/5 px-2 py-0.5 text-xs font-medium text-muted">
            Coming soon
          </span>
        </>
      ) : (
        <>
          <p className="mt-3 text-3xl font-semibold tabular-nums">
            <span className="sensitive">{value}</span>
          </p>
          {detail ? <p className="mt-2 text-xs text-muted">{detail}</p> : null}
        </>
      )}
    </div>
  );
}
