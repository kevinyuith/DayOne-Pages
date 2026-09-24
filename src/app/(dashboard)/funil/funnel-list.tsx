"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { ChevronRightIcon, PencilIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import { INPUT_CLASS, SELECT_BASE } from "@/components/ui/field";
import type { ScannedVersion } from "@/lib/pages/funnel-scan";
import type { FunnelBoardPage, FunnelBoardRow, VersionStats } from "@/lib/pages/queries";
import { PAGE_KINDS_SUB, SUB_KIND_LABELS, trafficShares, type SubPageKind } from "@/lib/pages/subpages";
import { PAGE_STATUS_LABELS } from "@/lib/pages/types";
import { CreateFunnelForm } from "./create-funnel-form";

/**
 * A tela Funil em lista: um funil do dayone-main (F1, F2…) por linha,
 * recolhido. Aberto, mostra as páginas dele e, em cada uma, as amostras de
 * cada etapa com tráfego, visitas, cliques e taxa (visitantes únicos, somando
 * as cópias em todos os domínios). Clicar numa amostra abre o editor nela.
 */

const DOT: Record<SubPageKind, string> = { presell: "bg-emerald-500", main: "bg-accent", backredirect: "bg-amber-500" };
const UNLINKED = "unlinked";

const num = (n: number) => n.toLocaleString("en-US");
const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
const rate = (s: VersionStats | undefined) => (s && s.views > 0 ? pct((s.clicks / s.views) * 100) : "—");

/** Quem o visitante vê primeiro numa página: as amostras ativas do Pre Lander, senão as do Lander. */
function entryVersions(versions: ScannedVersion[]): ScannedVersion[] {
  const pre = versions.filter((v) => v.kind === "presell" && v.active);
  return pre.length ? pre : versions.filter((v) => v.kind === "main" && v.active);
}

function sum(versions: ScannedVersion[], stats: Record<string, VersionStats>): VersionStats {
  return versions.reduce((t, v) => ({ views: t.views + (stats[v.id]?.views ?? 0), clicks: t.clicks + (stats[v.id]?.clicks ?? 0) }), { views: 0, clicks: 0 });
}

/** Os filtros da lista: campos do funil do dayone-main ("" = todos). */
const FILTERS = [
  { key: "platform", all: "All platforms" },
  { key: "niche", all: "All niches" },
  { key: "region", all: "All regions" },
  { key: "status", all: "All statuses" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const NO_FILTERS: Record<FilterKey, string> = { platform: "", niche: "", region: "", status: "" };

const GRID = "grid grid-cols-[1.5rem_3.5rem_minmax(12rem,1fr)_8rem_4rem_5rem_6rem_6rem_6rem_6rem_6rem] items-center gap-3";

export function FunnelList({
  rows,
  stats,
  templates,
  days,
  initialOpen,
}: {
  rows: FunnelBoardRow[];
  stats: Record<string, VersionStats>;
  templates: { id: string; name: string }[];
  days: number;
  initialOpen: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialOpen ? [initialOpen] : []));
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [filters, setFilters] = useState(NO_FILTERS);

  // As opções de cada filtro: os valores que os funis têm, em ordem alfabética.
  const options = useMemo(() => {
    const out = {} as Record<FilterKey, string[]>;
    for (const { key } of FILTERS) out[key] = [...new Set(rows.map((r) => r.funnel?.[key] ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return out;
  }, [rows]);
  const filtering = FILTERS.some(({ key }) => filters[key] !== "");

  const q = query.trim().toLowerCase();
  // Views da linha (a primeira etapa de cada página), para mostrar e para ordenar.
  const entryOf = useMemo(() => new Map(rows.map((r) => [r, sum(r.pages.flatMap((p) => entryVersions(p.versions)), stats)])), [rows, stats]);
  const shown = useMemo(
    () =>
      rows
        .filter((r) => {
          const f = r.funnel;
          // Com filtro, a linha de páginas sem funil sai (ela não tem plataforma, nicho…).
          if (FILTERS.some(({ key }) => filters[key] !== "" && (f?.[key] ?? "") !== filters[key])) return false;
          if (!q) return true;
          const hay = f ? [f.code, f.name, f.platform, f.niche, f.region, f.status] : ["unlinked"];
          return [...hay, ...r.pages.map((p) => p.name)].some((v) => (v ?? "").toLowerCase().includes(q));
        })
        // Mais views primeiro; empate pelo nome, depois pelo código (F1, F2…). Páginas sem funil no fim.
        .sort((a, b) => {
          if (!a.funnel || !b.funnel) return a.funnel ? -1 : b.funnel ? 1 : 0;
          return (
            (entryOf.get(b)?.views ?? 0) - (entryOf.get(a)?.views ?? 0) ||
            a.funnel.name.localeCompare(b.funnel.name) ||
            a.funnel.code.localeCompare(b.funnel.code, undefined, { numeric: true })
          );
        }),
    [rows, q, filters, entryOf],
  );
  const keyOf = (r: FunnelBoardRow) => r.funnel?.id ?? UNLINKED;
  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allOpen = shown.length > 0 && shown.every((r) => open.has(keyOf(r)));

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative w-full sm:w-64">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search F-code or name…" aria-label="Search" className={`${INPUT_CLASS} pl-8`} />
          </label>
          {FILTERS.map(({ key, all }) => (
            <select
              key={key}
              value={filters[key]}
              onChange={(e) => setFilters((cur) => ({ ...cur, [key]: e.target.value }))}
              aria-label={all.replace("All ", "Filter by ")}
              className={`${SELECT_BASE} h-9 w-auto text-sm ${filters[key] ? "border-accent/50 text-accent" : ""}`}
            >
              <option value="">{all}</option>
              {options[key].map((v) => (
                <option key={v} value={v}>
                  {key === "status" ? v.toLowerCase() : v}
                </option>
              ))}
            </select>
          ))}
          {filtering ? (
            <button type="button" onClick={() => setFilters(NO_FILTERS)} className="text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline">
              Clear filters
            </button>
          ) : null}
          <span className="text-xs text-muted">
            {shown.filter((r) => r.funnel).length} of {rows.filter((r) => r.funnel).length} funnels
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map(keyOf)))}
            className="h-8 rounded-md border border-border px-2.5 text-xs text-muted hover:text-foreground"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
          <nav className="flex gap-1 text-xs" aria-label="Period">
            {[7, 30, 90].map((p) => (
              <Link
                key={p}
                href={`/funil?days=${p}`}
                aria-current={p === days ? "page" : undefined}
                className={`flex h-8 items-center rounded-md border px-2.5 ${p === days ? "border-accent/50 bg-accent/10 text-accent" : "border-border text-muted hover:text-foreground"}`}
              >
                {p} days
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <div className="min-w-[64rem]">
          <div className={`${GRID} border-b border-border px-4 py-2.5 text-xs font-medium text-muted`}>
            <span />
            <span>Code</span>
            <span>Name</span>
            <span>Platform</span>
            <span>Niche</span>
            <span>Region</span>
            <span>Status</span>
            <span className="text-right">Samples</span>
            <span className="text-right">Views</span>
            <span className="text-right">Clicks</span>
            <span className="text-right">CTR</span>
          </div>

          {shown.map((r) => {
            const key = keyOf(r);
            const isOpen = open.has(key);
            const f = r.funnel;
            const samples = r.pages.reduce((n, p) => n + p.versions.filter((v) => v.active).length, 0);
            const entry = entryOf.get(r) ?? { views: 0, clicks: 0 };
            return (
              <Fragment key={key}>
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  aria-expanded={isOpen}
                  className={`${GRID} w-full border-b border-border px-4 py-3 text-left text-sm transition-colors hover:bg-foreground/[0.03] ${isOpen ? "bg-foreground/[0.03]" : ""}`}
                >
                  <ChevronRightIcon className={`size-4 text-muted transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  <span className="w-fit rounded-md bg-foreground/10 px-1.5 py-0.5 font-mono text-xs font-semibold">{f?.code ?? "—"}</span>
                  <span className="truncate font-medium">{f ? f.name : "Pages without a funnel"}</span>
                  <span className="truncate text-muted">{f?.platform ?? ""}</span>
                  <span className="text-muted">{f?.niche ?? ""}</span>
                  <span className="text-muted">{f?.region ?? ""}</span>
                  <span>{f?.status ? <Badge tone={f.status === "ACTIVE" ? "success" : f.status === "PAUSED" ? "warning" : "neutral"}>{f.status.toLowerCase()}</Badge> : null}</span>
                  <span className="text-right tabular-nums text-muted">{r.pages.length ? samples : "—"}</span>
                  <span className="text-right tabular-nums">{r.pages.length ? num(entry.views) : "—"}</span>
                  <span className="text-right tabular-nums">{r.pages.length ? num(entry.clicks) : "—"}</span>
                  <span className="text-right tabular-nums">{r.pages.length ? rate(entry) : "—"}</span>
                </button>

                {isOpen ? (
                  <div className="border-b border-border bg-foreground/[0.02] px-4 py-3">
                    {r.pages.length === 0 && creating !== key ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted">
                        <span>No pages in this funnel yet.</span>
                      </div>
                    ) : null}
                    <div className="flex flex-col gap-3">
                      {r.pages.map((p) => (
                        <PageTable key={p.id} page={p} stats={stats} />
                      ))}
                    </div>
                    {f ? (
                      creating === key ? (
                        <div className="mt-3 rounded-lg border border-border bg-surface p-3">
                          <CreateFunnelForm funnelId={f.id} defaultName={`${f.code} · ${f.name}`} templates={templates} onCancel={() => setCreating(null)} />
                        </div>
                      ) : (
                        <button type="button" onClick={() => setCreating(key)} className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">
                          <PlusIcon className="size-3.5" /> New page
                        </button>
                      )
                    ) : null}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          {shown.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No funnel matches the search and filters.</p> : null}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        Funnels come from dayone-main. Views and clicks are unique visitors in the last {days} days, adding up every domain copy; a click is leaving a sample for the next step or
        through a link (the offer). The funnel row counts its first step (Pre Lander, or Lander when there is none). Traffic is each sample&apos;s share of its step.
      </p>
    </div>
  );
}

/** Uma página do funil: as amostras de cada etapa, como a tabela do teste A/B. */
function PageTable({ page, stats }: { page: FunnelBoardPage; stats: Record<string, VersionStats> }) {
  const editHref = (sample?: string) => (page.slugId ? `/paginas/${page.id}/slugs/${page.slugId}${sample ? `?sample=${encodeURIComponent(sample)}` : ""}` : `/paginas/${page.id}`);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <span className="font-semibold">{page.name}</span>
        <Badge tone={PAGE_STATUS_TONE[page.status]}>{PAGE_STATUS_LABELS[page.status]}</Badge>
        <span className="text-xs text-muted">
          <code>{page.slug}</code> · {page.copies === 0 ? "not on any domain yet" : `on ${page.copies} ${page.copies === 1 ? "domain" : "domains"}`}
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs">
          <Link href={`/funil/${page.id}`} className="text-muted hover:text-foreground">
            Results by domain
          </Link>
          <Link href={editHref()} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
            <PencilIcon className="size-3.5" /> Edit page
          </Link>
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">Sample</th>
            <th className="px-3 py-2 text-right font-medium">Traffic</th>
            <th className="px-3 py-2 text-right font-medium">Views</th>
            <th className="px-3 py-2 text-right font-medium">Clicks</th>
            <th className="px-3 py-2 text-right font-medium">CTR</th>
            <th className="w-16 px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {page.versions.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-2 text-muted">
                Single page (just the Lander): open it to add a Pre Lander, a Backredirect or samples.
              </td>
            </tr>
          ) : (
            PAGE_KINDS_SUB.flatMap((kind) => {
              const mine = page.versions.filter((v) => v.kind === kind);
              const shares = trafficShares(mine);
              return mine.map((v) => {
                const s = stats[v.id];
                return (
                  <tr key={v.id} className={`group border-b border-border last:border-0 hover:bg-foreground/[0.03] ${v.active ? "" : "text-muted"}`}>
                    <td className="px-3 py-2">
                      <Link href={editHref(v.id)} className="flex items-center gap-2">
                        <span className={`size-2.5 shrink-0 rounded-full ${v.active ? DOT[kind] : "bg-foreground/20"}`} />
                        <span className="font-medium">{mine.length > 1 ? `${SUB_KIND_LABELS[kind]} · Sample ${v.letter}` : SUB_KIND_LABELS[kind]}</span>
                        {v.active ? null : <span className="text-xs">(inactive)</span>}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{v.active ? pct(shares.get(v.id) ?? 0) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(s?.views ?? 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(s?.clicks ?? 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{rate(s)}</td>
                    <td className="px-3 py-2 text-right">
                      <Link href={editHref(v.id)} className="text-xs font-medium text-accent opacity-0 hover:underline group-hover:opacity-100 focus:opacity-100">
                        Edit
                      </Link>
                    </td>
                  </tr>
                );
              });
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
