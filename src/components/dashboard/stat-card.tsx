import { SERIES_COLOR, type SeriesKey } from "@/components/dashboard/series";

export type Stat = {
  label: string;
  value: string;
  detail: string;
  /** Série do gráfico que este número resume: ganha a marca da cor dela. */
  series?: SeriesKey;
  /** Fração do total (0–1): desenha o medidor na cor da série. */
  share?: number;
};

/**
 * A faixa de métricas do topo do dashboard: um cartão só, dividido em células
 * por linhas finas (o fundo `bg-border` aparece no `gap-px`). Sem ícones: a
 * identidade vem do rótulo e, nas séries do gráfico, da mesma marca de cor da
 * legenda. No celular a primeira célula ocupa a linha inteira (5 = 1 + 2 + 2).
 */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-5">
      {stats.map((s, i) => (
        <StatCell key={s.label} stat={s} className={i === 0 ? "col-span-2 lg:col-span-1" : ""} />
      ))}
    </div>
  );
}

function StatCell({ stat, className }: { stat: Stat; className: string }) {
  const color = stat.series ? SERIES_COLOR[stat.series] : null;
  return (
    <div className={`flex min-w-0 flex-col bg-surface p-5 ${className}`}>
      <p className="flex items-center gap-2 text-sm text-muted">
        {color ? <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} /> : null}
        <span className="truncate">{stat.label}</span>
      </p>
      {/* Número grande em algarismos proporcionais (tabular só em colunas). */}
      <p className="mt-3 text-[28px] font-semibold leading-none tracking-tight">
        <span className="sensitive">{stat.value}</span>
      </p>
      <div className="mt-auto pt-4">
        {color && stat.share !== undefined ? (
          <div className="h-1 overflow-hidden rounded-full" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, stat.share * 100)}%`, background: color }} />
          </div>
        ) : (
          <div aria-hidden className="h-1" />
        )}
        <p className="mt-2 truncate text-xs text-muted">{stat.detail}</p>
      </div>
    </div>
  );
}
