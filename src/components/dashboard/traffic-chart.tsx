import { ConversionsIcon } from "@/components/icons";

const LEGEND = [
  { label: "Served", className: "bg-emerald-500" },
  { label: "Blocked", className: "bg-red-500" },
  { label: "Bots", className: "bg-amber-500" },
];

/**
 * O card "Traffic Overview" em estado de espera: a moldura do gráfico (título,
 * legenda, grade) pronta, mas sem curva — a coleta de tráfego ainda não existe,
 * então não há dado para desenhar. Fica igual ao layout, sem inventar números.
 */
export function TrafficChart() {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Traffic Overview</h2>
          <p className="mt-0.5 text-sm text-muted">Requests over time</p>
        </div>
        <div className="flex items-center gap-4">
          {LEGEND.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5 text-xs text-muted">
              <span className={`size-2.5 rounded-full ${l.className}`} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      <div className="relative mt-5 h-64">
        <div className="absolute inset-0 flex flex-col justify-between">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="border-t border-dashed border-border/60" />
          ))}
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-foreground/5 text-muted">
            <ConversionsIcon className="size-5" />
          </span>
          <p className="text-sm font-medium">Traffic tracking coming soon</p>
          <p className="max-w-xs text-xs text-muted">
            Once request logging is enabled on the delivery server, requests over time show up here.
          </p>
        </div>
      </div>
    </section>
  );
}
