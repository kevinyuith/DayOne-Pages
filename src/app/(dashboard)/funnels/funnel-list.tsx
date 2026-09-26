"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, useTransition } from "react";
import { ChevronRightIcon, FileIcon, LinkIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/icons";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { INPUT_CLASS } from "@/components/ui/field";
import type { FunnelBoardPage, FunnelBoardRow, VersionStats } from "@/lib/pages/queries";
import { PAGE_STATUS_LABELS, type PageKind } from "@/lib/pages/types";
import { CreatePageForm, type FunnelTarget } from "../templates/create-page-form";
import { evenSplit, normalizeShares } from "@/lib/pages/traffic";
import { createFunnelRedirect, removeFunnelPage, saveFunnelRedirect, saveFunnelShares } from "./actions";
import { FunnelFilterBar, NO_FUNNEL_FILTERS, funnelFilterOptions, funnelMatches } from "./funnel-filters";
import { FunnelVslsPanel } from "./funnel-vsls";

/**
 * The Funnel screen as a list: one dayone-main funnel (F1, F2…) per row,
 * collapsed. Open, it shows the A/B test between its pages, one row per
 * page: the traffic % (the funnel's % always add up to 100), real loads
 * (views), how many clicked out (clicks) and the rate, summing the copies on
 * all domains. Clicking a page opens the editor, a redirect its form. The %
 * are typed in the rows and saved together, only when they add up to 100.
 */

const UNLINKED = "unlinked";

const num = (n: number) => n.toLocaleString("en-US");
const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
const rate = (s: VersionStats | undefined) => (s && s.views > 0 ? pct((s.clicks / s.views) * 100) : "—");

/** Does the funnel have somewhere to send a click: a published page or redirect with a share above 0? */
const isLive = (pages: FunnelBoardPage[]) => pages.some((p) => p.status === "PUBLISHED" && p.weight > 0);

/** The funnel's numbers: the sum of its pages. */
function sum(pages: FunnelBoardPage[], stats: Record<string, VersionStats>): VersionStats {
  return pages.reduce((t, p) => ({ views: t.views + (stats[p.id]?.views ?? 0), clicks: t.clicks + (stats[p.id]?.clicks ?? 0) }), { views: 0, clicks: 0 });
}

const GRID = "grid grid-cols-[1.5rem_4.5rem_minmax(12rem,1fr)_8rem_4rem_5rem_6rem_6rem_6rem_6rem] items-center gap-3";

export function FunnelList({
  rows,
  stats,
  templates,
  days,
  initialOpen,
}: {
  rows: FunnelBoardRow[];
  /** Per library page: loads (views) and outbound clicks (clicks). */
  stats: Record<string, VersionStats>;
  /** For "copy from another template" (includes other funnels' pages). */
  templates: { id: string; name: string; kind: PageKind; slugs_count: number }[];
  days: number;
  initialOpen: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialOpen ? [initialOpen] : []));
  const [query, setQuery] = useState("");
  // New page: the same flow as "Create template" (source, preview, placeholders), already linked to the funnel.
  const [creating, setCreating] = useState<FunnelTarget | null>(null);
  // Redirect entry dialog: create (page = null) or edit an existing redirect.
  const [redir, setRedir] = useState<{ mainFunnelId: string; page: FunnelBoardPage | null; defaultName: string } | null>(null);
  const [filters, setFilters] = useState(NO_FUNNEL_FILTERS);
  // The tab open inside each funnel (Pages by default).
  const [tabOf, setTabOf] = useState<Record<string, "pages" | "vsls">>({});
  const options = useMemo(() => funnelFilterOptions(rows.map((r) => r.funnel)), [rows]);

  // Each funnel's numbers (sum of its pages), for display and sorting.
  const entryOf = useMemo(() => new Map(rows.map((r) => [r, sum(r.pages, stats)])), [rows, stats]);
  const shown = useMemo(
    () =>
      rows
        .filter((r) => funnelMatches(r.funnel, filters, query, r.pages.map((p) => p.name)))
        // Most views first; ties by name, then by code (F1, F2…). Pages without a funnel last.
        .sort((a, b) => {
          if (!a.funnel || !b.funnel) return a.funnel ? -1 : b.funnel ? 1 : 0;
          return (
            (entryOf.get(b)?.views ?? 0) - (entryOf.get(a)?.views ?? 0) ||
            a.funnel.name.localeCompare(b.funnel.name) ||
            a.funnel.code.localeCompare(b.funnel.code, undefined, { numeric: true })
          );
        }),
    [rows, query, filters, entryOf],
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
        <FunnelFilterBar
          query={query}
          onQuery={setQuery}
          filters={filters}
          onFilters={setFilters}
          options={options}
          shown={shown.filter((r) => r.funnel).length}
          total={rows.filter((r) => r.funnel).length}
        />
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
                href={`/funnels?days=${p}`}
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
                  <span className="flex items-center gap-1">
                    {/* No published page or redirect with traffic: the funnel has nowhere to send a click. */}
                    <span className="w-2 text-center font-bold text-red-600 dark:text-red-400" title={f && !isLive(r.pages) ? "No published page or redirect: this funnel gets no traffic." : undefined}>
                      {f && !isLive(r.pages) ? "!" : ""}
                    </span>
                    <span className="w-fit rounded-md bg-foreground/10 px-1.5 py-0.5 font-mono text-xs font-semibold">{f?.code ?? "—"}</span>
                  </span>
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
                    {f ? (
                      <nav className="mb-3 flex gap-1 border-b border-border" aria-label={`${f.code} tabs`}>
                        {(["pages", "vsls"] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setTabOf((cur) => ({ ...cur, [key]: t }))}
                            aria-current={(tabOf[key] ?? "pages") === t ? "page" : undefined}
                            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors ${
                              (tabOf[key] ?? "pages") === t ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
                            }`}
                          >
                            {t === "pages" ? "Pages" : "VSLs"}
                          </button>
                        ))}
                      </nav>
                    ) : null}
                    {f && tabOf[key] === "vsls" ? (
                      <FunnelVslsPanel mainFunnelId={f.id} label={`${f.code} · ${f.name}`} />
                    ) : (
                      <>
                        {r.pages.length === 0 ? (
                          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted">
                            <span>No pages in this funnel yet.</span>
                          </div>
                        ) : null}
                        {r.pages.length ? (
                          // The key resets the edited weights when the server returns the new ones.
                          <PagesTable key={r.pages.map((p) => `${p.id}:${p.weight}:${p.status}`).join()} funnelId={f ? (r.pages[0]?.funnelId ?? null) : null} pages={r.pages} stats={stats} onEditRedirect={f ? (p) => setRedir({ mainFunnelId: f.id, page: p, defaultName: p.name }) : undefined} />
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
                          </div>
                        ) : null}
                      </>
                    )}
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

      <Dialog open={redir !== null} title={redir?.page ? "Edit redirect" : "New redirect"} onClose={() => setRedir(null)} className="sm:max-w-xl">
        {redir ? <RedirectForm key={redir.page?.id ?? "new"} target={redir} onDone={() => setRedir(null)} onCancel={() => setRedir(null)} /> : null}
      </Dialog>
    </div>
  );
}

/**
 * The A/B test between a funnel's pages, one per row. The field is the page's
 * %; on leaving it, the others split the rest in the proportion they had (the
 * % always add up to 100 — traffic.ts, the same math the action saves).
 */
function PagesTable({ funnelId, pages, stats, onEditRedirect }: { funnelId: string | null; pages: FunnelBoardPage[]; stats: Record<string, VersionStats>; onEditRedirect?: (p: FunnelBoardPage) => void }) {
  const router = useRouter();
  // Only a published page or redirect gets traffic, so only those hold a share (they add up to 100).
  const live = pages.filter((p) => p.status === "PUBLISHED");
  // The saved shares, shown as each one's real share of the traffic: the stored values rescaled to 100
  // (the proportions the server uses). All at 0 = nothing is served, so they stay at 0.
  const [saved] = useState<Record<string, number>>(() => {
    const raw = Object.fromEntries(live.map((p) => [p.id, p.weight]));
    return live.some((p) => p.weight > 0) ? normalizeShares(raw) : raw;
  });
  // The fields as typed. Nothing is saved until Save, and Save only works when they add up to 100.
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(live.map((p) => [p.id, String(saved[p.id] ?? 0)])));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const editHref = (p: FunnelBoardPage) => `/funnels/${p.id}/edit`;
  // Highest saved share first (the rows don't move while typing).
  const sorted = [...pages].sort((a, b) => (saved[b.id] ?? -1) - (saved[a.id] ?? -1) || a.name.localeCompare(b.name));

  const valueOf = (id: string): number | null => {
    const t = (text[id] ?? "").trim();
    return /^\d{1,3}$/.test(t) && Number(t) <= 100 ? Number(t) : null;
  };
  const values = live.map((p) => valueOf(p.id));
  const valid = values.every((v) => v !== null);
  const total = values.reduce<number>((n, v) => n + (v ?? 0), 0);
  const dirty = live.some((p) => valueOf(p.id) !== (saved[p.id] ?? 0));
  const canSave = !!funnelId && valid && total === 100 && dirty && !pending;

  const evenly = () => {
    const even = evenSplit(live.map((p) => p.id));
    setText(Object.fromEntries(live.map((p) => [p.id, String(even[p.id] ?? 0)])));
  };
  const reset = () => {
    setError(null);
    setText(Object.fromEntries(live.map((p) => [p.id, String(saved[p.id] ?? 0)])));
  };
  // Deletes a page or redirect from the funnel; the published ones left are rescaled to 100.
  const remove = (p: FunnelBoardPage) => {
    const what = p.redirect !== null ? `the redirect "${p.name}"` : `the page "${p.name}"`;
    const lost = p.redirect !== null ? "" : " Its HTML will be lost.";
    if (!window.confirm(`Delete ${what} from the funnel?${lost} Copies on domains stay, but stop getting traffic.`)) return;
    start(async () => {
      const r = await removeFunnelPage(p.funnelId, p.id);
      setError(r.ok ? null : r.reason);
      if (r.ok) router.refresh();
    });
  };
  const save = () => {
    if (!canSave || !funnelId) return;
    start(async () => {
      const r = await saveFunnelShares(funnelId, Object.fromEntries(live.map((p) => [p.id, valueOf(p.id) ?? 0])));
      setError(r.ok ? null : r.reason);
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className={`overflow-hidden rounded-lg border border-border bg-surface ${pending ? "opacity-70" : ""}`}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-border">
              <th className="w-px px-3 py-2 font-medium">Traffic</th>
              <th className="px-3 py-2 font-medium">Page</th>
              <th className="px-3 py-2 text-right font-medium">Views</th>
              <th className="px-3 py-2 text-right font-medium">Clicks</th>
              <th className="px-3 py-2 text-right font-medium">CTR</th>
              <th className="px-3 py-2 text-right">
                {live.length > 1 && funnelId ? (
                  <button type="button" onClick={evenly} disabled={pending} className="text-xs font-medium text-muted hover:text-foreground">
                    Split evenly
                  </button>
                ) : null}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const s = stats[p.id];
              return (
                <tr key={p.id} className="border-b border-border last:border-0 hover:bg-foreground/[0.03]">
                  <td className="whitespace-nowrap px-3 py-2">
                    {p.status !== "PUBLISHED" ? (
                      <span className="text-xs text-muted" title="Only a published page gets traffic.">
                        —
                      </span>
                    ) : live.length > 1 ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={text[p.id] ?? ""}
                          onChange={(e) => setText({ ...text, [p.id]: e.target.value })}
                          onKeyDown={(e) => e.key === "Enter" && save()}
                          disabled={pending}
                          aria-label={`Traffic of ${p.name}`}
                          title="Share of the funnel's traffic (0 = paused)."
                          className={`h-7 w-14 rounded-md border bg-transparent px-1.5 text-right text-xs tabular-nums ${valueOf(p.id) === null ? "border-red-500" : "border-border"}`}
                        />
                        <span className="text-xs text-muted">%</span>
                      </span>
                    ) : (
                      <span className="tabular-nums">100%</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {p.redirect !== null ? (
                      <button type="button" onClick={() => onEditRedirect?.(p)} className="flex max-w-full items-center gap-2 text-left" title={p.redirect}>
                        <LinkIcon className="size-4 shrink-0 text-muted" />
                        <span className="font-medium">{p.name}</span>
                        <span className="truncate font-mono text-xs text-muted">→ {p.redirect}</span>
                      </button>
                    ) : (
                      <Link href={editHref(p)} className="flex items-center gap-2">
                        <FileIcon className="size-4 shrink-0 text-muted" />
                        <span className="font-medium">{p.name}</span>
                        <Badge tone={PAGE_STATUS_TONE[p.status]}>{PAGE_STATUS_LABELS[p.status]}</Badge>
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.redirect !== null ? "—" : num(s?.views ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.redirect !== null ? "—" : num(s?.clicks ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.redirect !== null ? "—" : rate(s)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-3 text-xs">
                      {p.redirect === null ? (
                        <Link href={editHref(p)} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                          <PencilIcon className="size-3.5" /> Edit
                        </Link>
                      ) : null}
                      <button type="button" onClick={() => remove(p)} disabled={pending} className="inline-flex items-center gap-1 font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400">
                        <TrashIcon className="size-3.5" /> Delete
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {live.length > 1 && funnelId ? (
        <div className="flex items-center justify-end gap-3 text-xs">
          <span className={valid && total === 100 ? "tabular-nums text-muted" : "font-medium tabular-nums text-red-600 dark:text-red-400"}>
            Total {total}%{valid && total !== 100 ? " · must be 100%" : ""}
          </span>
          {dirty ? (
            <Button size="sm" variant="ghost" onClick={reset} disabled={pending}>
              Reset
            </Button>
          ) : null}
          <Button size="sm" onClick={save} disabled={!canSave}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}


/** Create or edit a funnel redirect entry: name, destination URL template, and (when editing) status. */
function RedirectForm({ target, onDone, onCancel }: { target: { mainFunnelId: string; page: FunnelBoardPage | null; defaultName: string }; onDone: () => void; onCancel: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(target.page?.name ?? target.defaultName);
  const [url, setUrl] = useState(target.page?.redirect ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const r = target.page
        ? await saveFunnelRedirect(target.page.id, name, url)
        : await createFunnelRedirect(target.mainFunnelId, name, url);
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      onDone();
      router.refresh();
    });

  const remove = () => {
    const page = target.page;
    if (!page || !window.confirm(`Remove the redirect "${page.name}"? Copies on domains stay, but stop getting traffic.`)) return;
    start(async () => {
      const r = await removeFunnelPage(page.funnelId, page.id);
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      onDone();
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-4"
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={INPUT_CLASS} placeholder="Offer redirect" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Destination URL</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} className={`${INPUT_CLASS} font-mono text-xs`} placeholder="https://offer.com/?utm_campaign={sub1}" />
        <span className="text-xs text-muted">
          Use {"{name}"} to drop a visit parameter into the URL, e.g. {"{sub1}"} or {"{fbclid}"}. Only what the URL names is carried; anything else is left out.
        </span>
      </label>
      <div className="flex items-center justify-between gap-2">
        {target.page ? (
          <Button type="button" variant="ghost" onClick={remove} disabled={pending} className="text-red-600 hover:text-red-700 dark:text-red-400">
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : target.page ? "Save" : "Create redirect"}
          </Button>
        </div>
      </div>
    </form>
  );
}
