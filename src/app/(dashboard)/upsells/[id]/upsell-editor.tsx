"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { INPUT_CLASS } from "@/components/ui/field";
import { RANGES, RANGE_SHORT, type RangeKey } from "@/lib/pages/dashboard-filters";
import type { UpsellEditorData, UpsellPageOption } from "@/lib/pages/upsell";
import { VENDOR_PLATFORM_LABELS, isVendorPlatform } from "@/lib/pages/types";
import {
  DEFAULT_FRONT_PARAM,
  STEP_LABELS,
  UPSELL_STEPS,
  configChanges,
  funnelRoutes,
  newId,
  newUpsellStep,
  routeAdd,
  routeAddToStep,
  routeKey,
  routeRemove,
  routeUpdate,
  shareProblems,
  stepPath,
  type UpsellConfig,
} from "@/lib/pages/upsell-types";
import { APP_TZ } from "@/lib/time-zone";
import { discardUpsellDraft, loadUpsellMetrics, publishUpsellFunnel, restoreUpsellVersion, saveUpsellDraft } from "../actions";
import { fmtInt, revenue, visits } from "./metrics";
import { RevenueText } from "./revenue-text";
import { StepAliases } from "./step-aliases";
import { Pipeline, type Selection } from "./pipeline";
import { RoutePanel } from "./route-panel";
import { StepPanel, type Stage } from "./step-panel";
import { useUpsellVideos } from "./use-upsell-videos";

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: APP_TZ });
const SAVE_DELAY_MS = 700;

/**
 * The upsell funnel editor. It edits the DRAFT: every change is saved there a
 * moment later (only over the version that was read). The bar on top lists what
 * the draft changes against the live funnel; Publish makes it live (each
 * published version stays in the history, which can put one back in the draft).
 */
export function UpsellEditor({ data }: { data: UpsellEditorData }) {
  const router = useRouter();
  const [config, setConfig] = useState<UpsellConfig>(() => data.draft ?? data.live);
  const [name, setName] = useState(data.name);
  const [hasDraft, setHasDraft] = useState(data.draft !== null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("page");
  const [editingFlow, setEditingFlow] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const firstUpsell = config.steps.find((s) => s.id !== "ty");
  const [selected, setSelected] = useState<Selection>(() => ({ kind: "cell", step: firstUpsell?.id ?? "ty", group: firstUpsell?.groups?.[0]?.id ?? null }));
  const routes = useMemo(() => funnelRoutes(config), [config]);

  // ── The period's numbers (the Dashboard's ranges; switching reloads only the numbers) ──
  const [metrics, setMetrics] = useState(data.metrics);
  const [range, setRange] = useState<RangeKey>(data.metrics.range);
  const [loadingRange, startRange] = useTransition();
  const pickRange = (next: RangeKey) => {
    setRange(next);
    startRange(async () => {
      const r = await loadUpsellMetrics(data.id, next);
      if (!r.ok) {
        setRange(metrics.range);
        return setError(r.reason);
      }
      setMetrics(r.metrics);
      // The URL keeps the period (a reload or a shared link opens on it).
      window.history.replaceState(null, "", next === "7d" ? window.location.pathname : `${window.location.pathname}?range=${next}`);
    });
  };

  // Pages created here ("+ New upsell page") join the pickers at once.
  const [createdPages, setCreatedPages] = useState<UpsellPageOption[]>([]);
  const upsellPages = useMemo(
    () => [...data.upsellPages, ...createdPages.filter((p) => !data.upsellPages.some((x) => x.id === p.id))].sort((a, b) => a.name.localeCompare(b.name)),
    [data.upsellPages, createdPages],
  );

  // ── The draft: saved a moment after each change, one save at a time ──
  const expected = useRef(data.updatedAt);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<boolean>>(Promise.resolve(true));
  const latest = useRef({ config, name });
  useEffect(() => {
    latest.current = { config, name };
  }, [config, name]);

  const saveNow = useCallback((): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return saving.current;
    dirty.current = false;
    saving.current = saving.current.then(async () => {
      setSaveState("saving");
      const r = await saveUpsellDraft(data.id, latest.current.config, latest.current.name, expected.current);
      if (!r.ok) {
        setError(r.reason);
        setSaveState("idle");
        return false;
      }
      expected.current = r.updatedAt;
      setHasDraft(true);
      setError(null);
      setSaveState("saved");
      return true;
    });
    return saving.current;
  }, [data.id]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const touch = useCallback(() => {
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(), SAVE_DELAY_MS);
  }, [saveNow]);

  const update = useCallback(
    (fn: (c: UpsellConfig) => void) => {
      setConfig((prev) => {
        const next = structuredClone(prev);
        fn(next);
        return next;
      });
      touch();
    },
    [touch],
  );

  const vids = useUpsellVideos(data.id, data.videos, update);

  const pageNames = useMemo(() => Object.fromEntries(upsellPages.map((p) => [p.id, p.name])), [upsellPages]);
  const changes = useMemo(() => configChanges(data.live, config, pageNames), [data.live, config, pageNames]);
  const problems = useMemo(() => shareProblems(config), [config]);
  const pendingChanges = hasDraft || changes.length > 0;

  const publish = () =>
    start(async () => {
      if (!(await saveNow())) return;
      const r = await publishUpsellFunnel(data.id, expected.current);
      if (!r.ok) return setError(r.reason);
      router.refresh();
    });
  const discard = () =>
    start(async () => {
      if (timer.current) clearTimeout(timer.current);
      dirty.current = false;
      await saving.current;
      const r = await discardUpsellDraft(data.id, expected.current);
      if (!r.ok) return setError(r.reason);
      router.refresh();
    });
  const restore = (historyId: number) =>
    start(async () => {
      if (!(await saveNow())) return;
      const r = await restoreUpsellVersion(data.id, historyId, expected.current);
      if (!r.ok) return setError(r.reason);
      router.refresh();
    });

  // A removed step's selection falls back to the first upsell step.
  const step = selected.kind === "cell" ? (config.steps.find((s) => s.id === selected.step) ?? config.steps.find((s) => s.id !== "ty") ?? null) : null;
  const group = selected.kind === "cell" ? (step?.groups?.find((g) => g.id === selected.group) ?? step?.groups?.[0] ?? null) : null;
  const editingRoute = selected.kind === "route" ? (selected.key === null ? null : (routes.find((r) => r.key === selected.key) ?? undefined)) : undefined;
  const firstCell = (c: UpsellConfig): Selection => {
    const s = c.steps.find((x) => x.id !== "ty");
    return { kind: "cell", step: s?.id ?? "ty", group: s?.groups?.[0]?.id ?? null };
  };

  /** Applies a route change if it is valid (checked on a copy first): an error message, or null. */
  const changeRoutes = (fn: (c: UpsellConfig) => string | null): string | null => {
    const err = fn(structuredClone(config));
    if (err) return err;
    update((c) => void fn(c));
    return null;
  };
  const nextUpsell = UPSELL_STEPS.find((id) => !config.steps.some((s) => s.id === id));
  const ty = config.steps.find((s) => s.id === "ty");
  const platform = data.page.platform && isVendorPlatform(data.page.platform) ? VENDOR_PLATFORM_LABELS[data.page.platform] : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href="/upsells" className="text-sm text-muted hover:text-foreground">
          ← Upsells
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <input
            aria-label="Funnel name"
            value={name}
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value);
              touch();
            }}
            className="min-w-0 rounded-lg border border-transparent bg-transparent px-1 text-2xl font-semibold tracking-tight hover:border-border focus:border-accent focus:outline-none"
          />
          {platform ? <Badge tone="info">{platform}</Badge> : null}
          <span className="text-sm text-muted">{data.domains.length ? data.domains.map((d) => d.domain).join(", ") : "not on a domain"}</span>
          {data.liveAt ? <Badge tone="success">Live since {dateFmt.format(new Date(data.liveAt))}</Badge> : <Badge tone="neutral">Not published</Badge>}
          <span className="ml-auto text-xs text-muted" aria-live="polite">
            {saveState === "saving" ? "Saving draft…" : saveState === "saved" ? "Draft saved" : ""}
          </span>
        </div>
      </div>

      {pendingChanges ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-foreground px-4 py-3 text-sm text-background">
          <b>{changes.length === 0 ? "Draft equals the live funnel" : `${changes.length} unpublished change${changes.length === 1 ? "" : "s"}`}</b>
          <span className="min-w-0 flex-1 truncate opacity-80" title={changes.join("\n")}>
            {changes.slice(0, 3).join(" · ")}
            {changes.length > 3 ? ` · +${changes.length - 3} more` : ""}
          </span>
          <button type="button" onClick={discard} disabled={pending} className="rounded-lg px-3 py-1.5 font-semibold opacity-80 hover:opacity-100 disabled:opacity-40">
            Discard
          </button>
          <button
            type="button"
            onClick={publish}
            disabled={pending || problems.length > 0}
            title={problems.length ? `Shares must add up to 100%: ${problems.join("; ")}` : undefined}
            className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-white disabled:opacity-40"
          >
            {pending ? "Working…" : "Publish"}
          </button>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">Shares must add up to 100% before publishing: {problems.join("; ")}.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">Front parameter</span>
          <input
            value={config.front_param ?? DEFAULT_FRONT_PARAM}
            onChange={(e) => update((c) => { c.front_param = e.target.value.trim() || DEFAULT_FRONT_PARAM; })}
            className={`${INPUT_CLASS} w-32 font-mono`}
          />
        </label>
        <div role="group" aria-label="Period" className="inline-flex h-9 items-center rounded-lg border border-border bg-surface p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              title={r.label}
              onClick={() => range !== r.key && pickRange(r.key)}
              className={`h-full rounded-md px-3 text-sm font-medium transition-colors ${range === r.key ? "bg-foreground/[0.08] text-foreground" : "text-muted hover:text-foreground"}`}
            >
              {RANGE_SHORT[r.key]}
            </button>
          ))}
        </div>
        <span className={`text-muted transition-opacity ${loadingRange ? "opacity-50" : ""}`}>
          {fmtInt(visits(metrics.served, {}))} visits · <RevenueText inline exact={revenue(metrics.revenue, {}).revenue} estimated={revenue(metrics.revenue, {}).estimated} /> revenue
        </span>
        <button type="button" onClick={() => setHistoryOpen((o) => !o)} className="ml-auto font-semibold text-accent">
          History ({data.history.length})
        </button>
      </div>

      {historyOpen ? (
        <div className="rounded-xl border border-border bg-surface">
          {data.history.length === 0 ? <p className="px-4 py-3 text-sm text-muted">Nothing published yet.</p> : null}
          {data.history.map((h, i) => (
            <div key={h.id} className="flex items-start gap-3 border-b border-border/60 px-4 py-3 text-sm last:border-b-0">
              <span className="w-44 shrink-0 text-muted">{dateFmt.format(new Date(h.publishedAt))}</span>
              <span className="min-w-0 flex-1">{h.summary ?? "First version"}</span>
              {i === 0 ? <Badge tone="success">Live</Badge> : null}
              <button type="button" onClick={() => restore(h.id)} disabled={pending} className="shrink-0 font-semibold text-accent disabled:opacity-40">
                Restore
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className={`transition-opacity ${loadingRange ? "opacity-60" : ""}`}>
        <Pipeline
          config={config}
          routes={routes}
          selected={selected}
          served={metrics.served}
          revenueRows={metrics.revenue}
          checkout={data.checkout}
          folder={data.page.folder}
          onSelect={(s) => {
            setSelected(s);
            setEditingFlow(null);
          }}
          onAddUpsell={
            nextUpsell
              ? () => {
                  // The new step gets a group for every route the funnel has.
                  const upsell = newUpsellStep(nextUpsell, routes);
                  const gid = upsell.groups?.[0]?.id ?? null;
                  update((c) => {
                    const tyAt = c.steps.findIndex((s) => s.id === "ty");
                    if (tyAt >= 0) c.steps.splice(tyAt, 0, upsell);
                    else c.steps.push(upsell);
                  });
                  setSelected({ kind: "cell", step: nextUpsell, group: gid });
                }
              : null
          }
          onAddThankYou={
            ty
              ? null
              : () => {
                  update((c) => { c.steps.push({ id: "ty", slug: stepPath("ty") }); });
                  setSelected({ kind: "cell", step: "ty", group: null });
                }
          }
          onRouteToStep={(route, s) => {
            const gid = newId("g");
            const err = changeRoutes((c) => routeAddToStep(c, route, s.id, gid));
            if (err) return setError(err);
            setSelected({ kind: "cell", step: s.id, group: gid });
          }}
        />
      </div>

      {editingRoute !== undefined ? (
        <RoutePanel
          key={editingRoute?.key ?? "new"}
          config={config}
          route={editingRoute}
          served={metrics.served}
          revenueRows={metrics.revenue}
          onSave={(name, fronts) => {
            const err = changeRoutes((c) => (editingRoute ? routeUpdate(c, editingRoute.key, name, fronts) : routeAdd(c, name, fronts)));
            if (!err) setSelected({ kind: "route", key: routeKey(fronts) });
            return err;
          }}
          onRemove={() => {
            if (!editingRoute) return null;
            const err = changeRoutes((c) => routeRemove(c, editingRoute.key));
            if (!err) {
              const next = structuredClone(config);
              routeRemove(next, editingRoute.key);
              setSelected(firstCell(next));
            }
            return err;
          }}
          onCancel={() => setSelected(firstCell(config))}
          onOpen={(s, g) => setSelected({ kind: "cell", step: s, group: g })}
        />
      ) : step && step.id === "ty" ? (
        <section aria-label="Thank you" className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <b>{STEP_LABELS.ty}</b>
            <span className="text-muted">{fmtInt(visits(metrics.served, { step: "ty" }))} visits</span>
            <button
              type="button"
              onClick={() => {
                update((c) => { c.steps = c.steps.filter((s) => s.id !== "ty"); });
                setSelected(firstCell(config));
              }}
              className="ml-auto font-semibold text-red-600 dark:text-red-400"
            >
              Remove
            </button>
          </div>
          <StepAliases config={config} step={step} folder={data.page.folder} update={update} />
        </section>
      ) : step && group ? (
        <StepPanel
          config={config}
          step={step}
          group={group}
          upsellPages={upsellPages}
          videos={vids.videos}
          uploads={vids.uploads}
          onUpload={(file) => void vids.upload(step.id, group.id, file)}
          onRetryVideo={(id) => void vids.retry(id)}
          onDismissUpload={vids.dismiss}
          checkout={data.checkout}
          served={metrics.served}
          answerRows={metrics.answers}
          revenueRows={metrics.revenue}
          stage={stage}
          onStage={setStage}
          editingFlow={editingFlow}
          onEditFlow={setEditingFlow}
          update={update}
          onSelectGroup={(g) => {
            const s = config.steps.find((x) => x.id === step.id);
            setSelected({ kind: "cell", step: step.id, group: g ?? s?.groups?.find((x) => x.id !== group.id)?.id ?? null });
          }}
          funnelId={data.id}
          templates={data.templates}
          copySources={data.copySources}
          onPageCreated={(page) => setCreatedPages((prev) => [...prev, page])}
          onEditRoute={(key) => {
            setSelected({ kind: "route", key });
            setEditingFlow(null);
          }}
          folder={data.page.folder}
        />
      ) : (
        <p className="text-sm text-muted">Add an upsell to start.</p>
      )}
    </div>
  );
}
