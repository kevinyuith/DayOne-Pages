"use client";

import { useRef, useState } from "react";
import type { HitBucket } from "@/lib/pages/queries";

/**
 * Traffic Overview: uma linha por série (Served/Blocked/Bots) ao longo do dia.
 * Cores validadas (scripts/validate_palette.js da skill dataviz) para dark e
 * light — verde/vermelho/violeta passam faixa de luminosidade, CVD, visão
 * normal e contraste. Identidade vem da legenda (sempre presente) + hover, não
 * só da cor. Sem eixo duplo, marcas finas, grade recessiva.
 */

const SERIES = [
  { key: "served", label: "Served", color: "#059669" },
  { key: "blocked", label: "Blocked", color: "#dc2626" },
  { key: "bots", label: "Bots", color: "#7c3aed" },
] as const;

const W = 960;
const H = 280;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

function niceCeil(v: number): number {
  if (v <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const fmt = new Intl.NumberFormat("en-US");

export function TrafficChart({ buckets }: { buckets: HitBucket[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const total = buckets.reduce((s, b) => s + b.served + b.blocked + b.bots, 0);
  const maxY = niceCeil(Math.max(1, ...buckets.map((b) => Math.max(b.served, b.blocked, b.bots))));
  const n = buckets.length;

  const xFor = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v: number) => PAD.top + plotH * (1 - v / maxY);
  const pathFor = (key: "served" | "blocked" | "bots") =>
    buckets.map((b, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(b[key]).toFixed(1)}`).join(" ");

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxY * f));
  const labelHour = (iso: string) => {
    const d = new Date(iso);
    return `${d.getHours()}h`;
  };

  const onMove = (e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((x - PAD.left) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Traffic Overview</h2>
          <p className="mt-0.5 text-sm text-muted">Requests over time · last 24h</p>
        </div>
        <div className="flex items-center gap-4">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-muted">
              <span className="size-2.5 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <div className="mt-5 flex h-56 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
          <p className="text-sm font-medium">No traffic in the last 24h</p>
          <p className="max-w-sm text-xs text-muted">Requests appear here as the delivery server logs them.</p>
        </div>
      ) : (
        <div className="relative mt-4">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ height: "auto" }}
            role="img"
            aria-label="Requests over time"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {gridVals.map((v, i) => {
              const y = yFor(v);
              return (
                <g key={i}>
                  <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} className="stroke-border" strokeDasharray="3 4" strokeWidth={1} />
                  <text x={PAD.left - 8} y={y + 3} textAnchor="end" className="fill-muted" style={{ fontSize: 11 }}>
                    {fmt.format(v)}
                  </text>
                </g>
              );
            })}

            {buckets.map((b, i) =>
              i % Math.ceil(n / 8) === 0 || i === n - 1 ? (
                <text key={i} x={xFor(i)} y={H - 8} textAnchor="middle" className="fill-muted" style={{ fontSize: 11 }}>
                  {labelHour(b.bucket)}
                </text>
              ) : null,
            )}

            {SERIES.map((s) => (
              <path key={s.key} d={pathFor(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}

            {hover !== null ? (
              <>
                <line x1={xFor(hover)} y1={PAD.top} x2={xFor(hover)} y2={PAD.top + plotH} className="stroke-muted" strokeWidth={1} />
                {SERIES.map((s) => (
                  <circle key={s.key} cx={xFor(hover)} cy={yFor(buckets[hover][s.key])} r={4} fill={s.color} className="stroke-surface" strokeWidth={2} />
                ))}
              </>
            ) : null}
          </svg>

          {hover !== null ? (
            <div
              className="pointer-events-none absolute top-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
              style={{ left: `${(xFor(hover) / W) * 100}%`, transform: `translateX(${hover > n / 2 ? "-110%" : "12px"})` }}
            >
              <p className="mb-1 font-medium">{labelHour(buckets[hover].bucket)}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center gap-1.5 tabular-nums text-muted">
                  <span className="size-2 rounded-full" style={{ background: s.color }} />
                  {s.label}: <span className="font-medium text-foreground">{fmt.format(buckets[hover][s.key])}</span>
                </p>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
