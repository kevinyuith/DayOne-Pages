"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, useTransition } from "react";
import { ChevronRightIcon, PencilIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { INPUT_CLASS, SELECT_BASE } from "@/components/ui/field";
import type { FunnelBoardPage, FunnelBoardRow, VersionStats } from "@/lib/pages/queries";
import { PAGE_STATUS_LABELS, type PageKind, type PageStatus } from "@/lib/pages/types";
import { CreatePageForm, type FunnelTarget } from "../paginas/create-page-form";
import { evenSplit, setShare } from "@/lib/pages/traffic";
import { copyFunnelToDomain, setPageShare, splitFunnelEvenly } from "./actions";

/**
 * A tela Funil em lista: um funil do dayone-main (F1, F2…) por linha,
 * recolhido. Aberto, mostra o teste A/B entre as páginas dele, uma linha por
 * página: o % do tráfego (os % do funil somam sempre 100), carregamentos reais
 * (views), quantos clicaram para fora (clicks) e a taxa, somando as cópias em
 * todos os domínios. Clicar na página abre o editor; "Copy to domain" leva o
 * funil inteiro, e no domínio as páginas disputam a mesma URL pelos pesos.
 */

const STATUS_DOT: Record<PageStatus, string> = { PUBLISHED: "bg-emerald-500", DRAFT: "bg-amber-500", ARCHIVED: "bg-foreground/30" };
const UNLINKED = "unlinked";

const num = (n: number) => n.toLocaleString("en-US");
const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
const rate = (s: VersionStats | undefined) => (s && s.views > 0 ? pct((s.clicks / s.views) * 100) : "—");

/** Os números do funil: a soma das páginas dele. */
function sum(pages: FunnelBoardPage[], stats: Record<string, VersionStats>): VersionStats {
  return pages.reduce((t, p) => ({ views: t.views + (stats[p.id]?.views ?? 0), clicks: t.clicks + (stats[p.id]?.clicks ?? 0) }), { views: 0, clicks: 0 });
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

const GRID = "grid grid-cols-[1.5rem_3.5rem_minmax(12rem,1fr)_8rem_4rem_5rem_6rem_6rem_6rem_6rem] items-center gap-3";

export function FunnelList({
  rows,
  stats,
  templates,
  domains,
  days,
  initialOpen,
}: {
  rows: FunnelBoardRow[];
  /** Por página da biblioteca: carregamentos (views) e cliques para fora (clicks). */
  stats: Record<string, VersionStats>;
  /** Para onde "Copy to domain" pode levar o funil. */
  domains: { id: string; domain: string }[];
  /** Para "copiar de outro template" (inclui as páginas de outros funis). */
  templates: { id: string; name: string; kind: PageKind; slugs_count: number }[];
  days: number;
  initialOpen: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialOpen ? [initialOpen] : []));
  const [query, setQuery] = useState("");
  // Página nova: o mesmo fluxo do "Create template" (origem, preview, marcadores), já ligada ao funil.
  const [creating, setCreating] = useState<FunnelTarget | null>(null);
  const [filters, setFilters] = useState(NO_FILTERS);

  // As opções de cada filtro: os valores que os funis têm, em ordem alfabética.
  const options = useMemo(() => {
    const out = {} as Record<FilterKey, string[]>;
    for (const { key } of FILTERS) out[key] = [...new Set(rows.map((r) => r.funnel?.[key] ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return out;
  }, [rows]);
  const filtering = FILTERS.some(({ key }) => filters[key] !== "");

  const q = query.trim().toLowerCase();
  // Os números de cada funil (soma das páginas), para mostrar e para ordenar.
  const entryOf = useMemo(() => new Map(rows.map((r) => [r, sum(r.pages, stats)])), [rows, stats]);
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
            <span className="text-right">Views</span>
            <span className="text-right">Clicks</span>
            <span className="text-right">CTR</span>
          </div>

          {shown.map((r) => {
            const key = keyOf(r);
            const isOpen = open.has(key);
            const f = r.funnel;
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
                  <span className="text-right tabular-nums">{r.pages.length ? num(entry.views) : "—"}</span>
                  <span className="text-right tabular-nums">{r.pages.length ? num(entry.clicks) : "—"}</span>
                  <span className="text-right tabular-nums">{r.pages.length ? rate(entry) : "—"}</span>
                </button>

                {isOpen ? (
                  <div className="border-b border-border bg-foreground/[0.02] px-4 py-3">
                    {r.pages.length === 0 ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted">
                        <span>No pages in this funnel yet.</span>
                      </div>
                    ) : null}
                    {r.pages.length ? (
                      // A key recomeça os pesos editados quando o servidor devolve os novos.
                      <PagesTable key={r.pages.map((p) => `${p.id}:${p.weight}`).join()} funnelId={f?.id ?? null} pages={r.pages} stats={stats} />
                    ) : null}
                    {f ? (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => setCreating({ id: f.id, defaultName: `${f.code} · ${f.name}` })}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
                        >
                          <PlusIcon className="size-3.5" /> New page
                        </button>
                        {r.pages.length ? <CopyToDomain funnelId={f.id} domains={domains} /> : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          {shown.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No funnel matches the search and filters.</p> : null}
        </div>
      </div>

      <Dialog open={creating !== null} title={creating ? `New page · ${creating.defaultName}` : "New page"} onClose={() => setCreating(null)} className="sm:max-w-2xl">
        {creating ? <CreatePageForm key={creating.id} templates={templates} funnel={creating} onCancel={() => setCreating(null)} /> : null}
      </Dialog>
    </div>
  );
}

/**
 * O teste A/B entre as páginas de um funil, uma por linha. O campo é o % da
 * página; ao sair dele, as outras dividem o resto na proporção que tinham (os
 * % somam sempre 100 — traffic.ts, a mesma conta que a action grava).
 */
function PagesTable({ funnelId, pages, stats }: { funnelId: string | null; pages: FunnelBoardPage[]; stats: Record<string, VersionStats> }) {
  const router = useRouter();
  const [shares, setShares] = useState<Record<string, number>>(() => Object.fromEntries(pages.map((p) => [p.id, p.weight])));
  const [draft, setDraft] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const editHref = (p: FunnelBoardPage) => (p.slugId ? `/paginas/${p.id}/slugs/${p.slugId}` : `/paginas/${p.id}`);

  // O valor vem do campo (não do estado): sair logo depois de digitar ainda grava o número novo.
  const commit = (p: FunnelBoardPage, raw: string) => {
    setDraft(null);
    const value = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
    if (value === shares[p.id]) return;
    setShares(setShare(shares, p.id, value));
    start(async () => {
      const r = await setPageShare(p.id, value);
      setError(r.ok ? null : r.reason);
      router.refresh();
    });
  };
  const evenly = () => {
    if (!funnelId) return;
    setShares(evenSplit(pages.map((p) => p.id)));
    start(async () => {
      const r = await splitFunnelEvenly(funnelId);
      setError(r.ok ? null : r.reason);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className={`overflow-hidden rounded-lg border border-border bg-surface ${pending ? "opacity-70" : ""}`}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-2 font-medium">Page</th>
              <th className="px-3 py-2 text-right font-medium">Traffic</th>
              <th className="px-3 py-2 text-right font-medium">Views</th>
              <th className="px-3 py-2 text-right font-medium">Clicks</th>
              <th className="px-3 py-2 text-right font-medium">CTR</th>
              <th className="px-3 py-2 text-right">
                {pages.length > 1 && funnelId ? (
                  <button type="button" onClick={evenly} disabled={pending} className="text-xs font-medium text-muted hover:text-foreground">
                    Split evenly
                  </button>
                ) : null}
              </th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => {
              const s = stats[p.id];
              const w = shares[p.id] ?? 0;
              return (
                <tr key={p.id} className="border-b border-border last:border-0 hover:bg-foreground/[0.03]">
                  <td className="px-3 py-2">
                    <Link href={editHref(p)} className="flex items-center gap-2">
                      <span className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT[p.status]}`} />
                      <span className="font-medium">{p.name}</span>
                      <Badge tone={PAGE_STATUS_TONE[p.status]}>{PAGE_STATUS_LABELS[p.status]}</Badge>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {pages.length > 1 ? (
                      <span className="inline-flex items-center justify-end gap-1">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={draft?.id === p.id ? draft.value : String(w)}
                          onChange={(e) => setDraft({ id: p.id, value: e.target.value })}
                          onBlur={(e) => commit(p, e.currentTarget.value)}
                          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                          aria-label={`Traffic of ${p.name}`}
                          title="Share of the funnel's traffic (0 = paused). The pages always add up to 100%."
                          className="h-7 w-14 rounded-md border border-border bg-transparent px-1.5 text-right text-xs tabular-nums"
                        />
                        <span className="text-xs text-muted">%</span>
                      </span>
                    ) : (
                      <span className="tabular-nums">100%</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(s?.views ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(s?.clicks ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{rate(s)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-3 text-xs">
                      <Link href={`/funil/${p.id}`} className="text-muted hover:text-foreground">
                        By domain
                      </Link>
                      <Link href={editHref(p)} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                        <PencilIcon className="size-3.5" /> Edit
                      </Link>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}

/** Copia o funil inteiro (todas as páginas) para um domínio; lá elas disputam a mesma URL pelos pesos. */
function CopyToDomain({ funnelId, domains }: { funnelId: string; domains: { id: string; domain: string }[] }) {
  const router = useRouter();
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (!domains.length) return null;
  const onCopy = () =>
    start(async () => {
      const r = await copyFunnelToDomain(domainId, funnelId);
      const name = domains.find((d) => d.id === domainId)?.domain ?? "the domain";
      setNotice(r.ok ? { ok: true, text: `Copied ${r.copied} ${r.copied === 1 ? "page" : "pages"} to ${name}.` } : { ok: false, text: r.reason });
      router.refresh();
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {notice ? <span className={`text-xs ${notice.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{notice.text}</span> : null}
      <select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="Domain" className={`${SELECT_BASE} h-8 w-56 text-xs`} disabled={pending}>
        {domains.map((d) => (
          <option key={d.id} value={d.id}>
            {d.domain}
          </option>
        ))}
      </select>
      <Button size="sm" variant="secondary" onClick={onCopy} disabled={pending || !domainId}>
        {pending ? "Copying…" : "Copy funnel to domain"}
      </Button>
    </div>
  );
}
