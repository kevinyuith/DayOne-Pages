"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SERIES, type SeriesKey } from "@/components/dashboard/series";
import { APP_TZ } from "@/lib/time-zone";
import type { HitBucket } from "@/lib/pages/queries";

/**
 * Traffic: uma linha por série (Served/Blocked/Bots) ao longo do período
 * (buckets por hora em Today/24h, por dia em 7/30 dias).
 *
 * Desenhado na largura e altura reais da área (ResizeObserver), não num
 * viewBox esticado: o texto dos eixos fica em 11px em qualquer tela. Eixo Y
 * com passos redondos (0/20/40/60), grade em linha fina contínua. Served, a
 * série principal, ganha um véu de área; série sem nenhum valor no período não
 * é desenhada (ficaria em cima do eixo) e aparece apagada na legenda.
 * Hover e teclado (setas, Home/End, Esc): linha vertical + tooltip com todas
 * as séries do ponto. Uma tabela sr-only repete os números para leitor de tela.
 */

const PAD = { top: 12, right: 8, bottom: 28, left: 40 };

/** Passo "redondo" e inteiro ≥ raw: 1, 2, 5, 10, 20, 25, 50, 100… */
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const s = m * pow;
    if (s >= raw && Number.isInteger(s)) return s;
  }
  return 10 * pow;
}

const fmt = new Intl.NumberFormat("en-US");
// Fuso fixo: os buckets diários são meia-noite de APP_TZ, e o SSR não depende do fuso do servidor.
const hourFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: APP_TZ });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: APP_TZ });
const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: APP_TZ });

export function TrafficChart({
  buckets,
  granularity = "hour",
  periodLabel = "Last 24 hours",
}: {
  buckets: HitBucket[];
  granularity?: "hour" | "day";
  periodLabel?: string;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoverRaw, setHover] = useState<number | null>(null);
  const gradId = `served-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const n = buckets.length;
  const totals = Object.fromEntries(SERIES.map((s) => [s.key, buckets.reduce((sum, b) => sum + b[s.key], 0)])) as Record<SeriesKey, number>;
  const hasData = SERIES.some((s) => totals[s.key] > 0);
  // Um filtro novo pode encurtar a série com o hover ainda aberto.
  const hover = hoverRaw !== null && hoverRaw < n ? hoverRaw : null;

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);

  const { w: W, h: H } = size;
  const plotW = Math.max(0, W - PAD.left - PAD.right);
  const plotH = Math.max(0, H - PAD.top - PAD.bottom);
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.served, b.blocked, b.bots)));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const yTicks = Array.from({ length: top / step + 1 }, (_, i) => i * step);

  const xFor = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v: number) => PAD.top + plotH * (1 - v / top);
  const linePath = (key: SeriesKey) => buckets.map((b, i) => `${i ? "L" : "M"}${xFor(i).toFixed(1)},${yFor(b[key]).toFixed(1)}`).join("");
  const areaPath = (key: SeriesKey) =>
    `${linePath(key)}L${xFor(n - 1).toFixed(1)},${yFor(0).toFixed(1)}L${xFor(0).toFixed(1)},${yFor(0).toFixed(1)}Z`;

  // Rótulos do eixo X a cada `every` pontos, contados a partir do último (o agora sempre tem rótulo).
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 84))));
  const xTicks = buckets.map((_, i) => i).filter((i) => (n - 1 - i) % every === 0);
  const axisLabel = (iso: string) => {
    const d = new Date(iso);
    if (granularity === "day") return dayFmt.format(d);
    const hh = hourFmt.format(d);
    // Na virada do dia o rótulo mostra a data, para situar o eixo.
    return hh === "00:00" ? dayFmt.format(d) : hh;
  };
  const tipLabel = (iso: string) => {
    const d = new Date(iso);
    if (granularity === "day") return weekdayFmt.format(d);
    return `${dayFmt.format(d)} · ${hourFmt.format(d)}–${hourFmt.format(new Date(d.getTime() + 3600_000))}`;
  };

  // De trás para a frente: Served (a principal) por cima das outras.
  const drawn = SERIES.filter((s) => totals[s.key] > 0).reverse();
  const served = SERIES[0];

  const pickAt = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const i = n <= 1 ? 0 : Math.round(((clientX - rect.left - PAD.left) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setHover(null);
    const cur = hover ?? n - 1;
    const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setHover(Math.max(0, Math.min(n - 1, next)));
  };

  const flip = hover !== null && xFor(hover) > W * 0.6;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="text-base font-semibold">Traffic</h2>
          <p className="mt-0.5 text-sm text-muted">
            Requests per {granularity} · {periodLabel.toLowerCase()}
          </p>
        </div>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1" aria-label="Legend">
          {SERIES.map((s) => {
            const empty = totals[s.key] === 0;
            return (
              <li
                key={s.key}
                className={`inline-flex items-center gap-2 text-xs ${empty ? "text-muted/60" : "text-muted"}`}
                title={empty ? `No ${s.label.toLowerCase()} requests in this period` : undefined}
              >
                <span aria-hidden className="h-0.5 w-3.5 rounded-full" style={{ background: s.color, opacity: empty ? 0.35 : 1 }} />
                {s.label}
              </li>
            );
          })}
        </ul>
      </div>

      {!hasData ? (
        <div className="mt-5 flex h-[220px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-center sm:h-[280px] xl:h-[320px]">
          <p className="text-sm font-medium">No traffic · {periodLabel.toLowerCase()}</p>
          <p className="max-w-sm text-xs text-muted">Requests appear here as the delivery server logs them.</p>
        </div>
      ) : (
        <div
          ref={plotRef}
          data-chart-plot
          tabIndex={0}
          role="group"
          aria-label={`Requests per ${granularity}, ${periodLabel.toLowerCase()}. Use the arrow keys to read each point.`}
          onKeyDown={onKey}
          onFocus={() => setHover((h) => h ?? n - 1)}
          onBlur={() => setHover(null)}
          onPointerMove={(e) => pickAt(e.clientX)}
          onPointerDown={(e) => pickAt(e.clientX)}
          // No toque o pointerleave vem logo depois do pointerup: o tooltip fica até tocar fora (blur).
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
          className="relative mt-5 h-[220px] touch-pan-y rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:h-[280px] xl:h-[320px]"
        >
          {W > 0 && H > 0 ? (
            <svg width={W} height={H} className="block" aria-hidden>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={served.color} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={served.color} stopOpacity={0} />
                </linearGradient>
              </defs>

              {yTicks.map((v) => (
                <g key={v}>
                  <line x1={PAD.left} x2={W - PAD.right} y1={yFor(v)} y2={yFor(v)} className={v === 0 ? "stroke-muted/40" : "stroke-border"} strokeWidth={1} />
                  <text x={PAD.left - 10} y={yFor(v)} dy="0.32em" textAnchor="end" className="fill-muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                    {fmt.format(v)}
                  </text>
                </g>
              ))}

              {xTicks.map((i) => (
                <text
                  key={i}
                  x={xFor(i)}
                  y={H - 8}
                  textAnchor={n > 1 && i === n - 1 ? "end" : n > 1 && i === 0 ? "start" : "middle"}
                  className="fill-muted"
                  style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}
                >
                  {axisLabel(buckets[i].bucket)}
                </text>
              ))}

              {totals.served > 0 && n > 1 ? <path d={areaPath("served")} fill={`url(#${gradId})`} /> : null}
              {drawn.map((s) => (
                <path key={s.key} d={linePath(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}

              {hover !== null ? (
                <line x1={xFor(hover)} x2={xFor(hover)} y1={PAD.top} y2={PAD.top + plotH} className="stroke-muted/60" strokeWidth={1} />
              ) : null}
              {drawn.map((s) =>
                hover !== null || n === 1 ? (
                  <circle
                    key={s.key}
                    cx={xFor(hover ?? 0)}
                    cy={yFor(buckets[hover ?? 0][s.key])}
                    r={4}
                    fill={s.color}
                    className="stroke-surface"
                    strokeWidth={2}
                  />
                ) : null,
              )}
            </svg>
          ) : null}

          {hover !== null && W > 0 ? (
            <div
              role="status"
              className="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs shadow-lg"
              style={{ left: xFor(hover), top: PAD.top, transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
            >
              <p className="mb-1.5 font-medium text-foreground">{tipLabel(buckets[hover].bucket)}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center gap-2 py-0.5">
                  <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                  <span className="text-muted">{s.label}</span>
                  <span className="ml-auto pl-4 font-semibold tabular-nums text-foreground">{fmt.format(buckets[hover][s.key])}</span>
                </p>
              ))}
            </div>
          ) : null}

          <table className="sr-only">
            <caption>Requests per {granularity}</caption>
            <thead>
              <tr>
                <th scope="col">{granularity === "day" ? "Day" : "Hour"}</th>
                {SERIES.map((s) => (
                  <th key={s.key} scope="col">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.bucket}>
                  <th scope="row">{tipLabel(b.bucket)}</th>
                  {SERIES.map((s) => (
                    <td key={s.key}>{b[s.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
