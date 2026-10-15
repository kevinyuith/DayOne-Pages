"use client";

import { useState, type ReactNode } from "react";
import { INPUT_CLASS, SELECT_BASE } from "@/components/ui/field";
import type { UpsellAnswer, UpsellCopySource, UpsellPageOption, UpsellRevenue, UpsellServed, UpsellVideo } from "@/lib/pages/upsell";
import {
  DEFAULT_FLOW,
  MAX_DOWNSELLS,
  MAX_FLOWS,
  MAX_VERSIONS,
  STEP_LABELS,
  newId,
  routeKey,
  routeRemoveFromStep,
  ruleChips,
  type UpsellConfig,
  type UpsellFlow,
  type UpsellGroup,
  type UpsellStep,
} from "@/lib/pages/upsell-types";
import { stepPaths } from "@/lib/pages/vendor-paths";
import { answers, flowShares, fmtInt, fmtPct, origin, revenue, visits } from "./metrics";
import { PerVisitText, RevenueText } from "./revenue-text";
import { NewUpsellPage } from "./new-upsell-page";
import { RuleEditor } from "./rule-editor";
import { StepAliases } from "./step-aliases";
import type { UploadProgress } from "./use-upsell-videos";
import { VslUploads } from "./vsl-uploads";

export type Stage = "page" | "vsl" | "cta" | "downsell";
const STAGES: { id: Stage; label: string }[] = [
  { id: "page", label: "Page" },
  { id: "vsl", label: "VSL" },
  { id: "cta", label: "CTA" },
  { id: "downsell", label: "Downsell" },
];
type Update = (fn: (c: UpsellConfig) => void) => void;

const LEFT = "w-[540px] shrink-0 border-r border-border";
const CELL = "w-24 shrink-0 px-2 text-center text-sm tabular-nums";

/** A share input (0–100). */
function Share({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <input
        type="number"
        min={0}
        max={100}
        step={1}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
        className={`${INPUT_CLASS} w-20 text-right tabular-nums`}
      />
      <span className="text-sm text-muted">%</span>
    </span>
  );
}

/** The share total of a list, flagged when it isn't 100. */
function Total({ list }: { list: { weight: number }[] }) {
  if (list.length === 0) return null;
  const sum = list.reduce((a, v) => a + v.weight, 0);
  return <span className={`text-xs font-semibold ${sum === 100 ? "text-muted" : "text-amber-700 dark:text-amber-400"}`}>{sum === 100 ? "100%" : `${sum}% — must be 100%`}</span>;
}

function Row({ left, cells }: { left: ReactNode; cells: ReactNode[] }) {
  return (
    <div className="flex border-b border-border/60">
      <div className={`${LEFT} flex flex-wrap items-center gap-2 px-4 py-2.5`}>{left}</div>
      <div className="flex flex-1 items-center">{cells.map((c, i) => <div key={i} className={CELL}>{c}</div>)}</div>
    </div>
  );
}

function Remove({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="ml-auto size-8 rounded-md text-muted hover:bg-foreground/5 hover:text-foreground">
      ×
    </button>
  );
}

function AddButton({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="min-h-10 px-1 text-sm font-semibold text-accent disabled:opacity-40">
      {children}
    </button>
  );
}

/**
 * The selected group of an upsell step: its settings and, under Page › VSL ›
 * CTA › Downsell, the versions with their shares and the period's numbers.
 * Page versions are per flow (the funnel's flows, in order, then Default): each
 * flow's header shows its rule as tags, how many of the group's buyers it took,
 * and opens its rule right under it.
 */
export function StepPanel({
  config,
  step,
  group,
  upsellPages,
  videos,
  uploads,
  onUpload,
  onRetryVideo,
  onDismissUpload,
  checkout,
  served,
  answerRows,
  revenueRows,
  stage,
  onStage,
  editingFlow,
  onEditFlow,
  update,
  onSelectGroup,
  funnelId,
  templates,
  copySources,
  onPageCreated,
  onEditRoute,
  folder,
}: {
  config: UpsellConfig;
  step: UpsellStep;
  group: UpsellGroup;
  /** The vendor page's folder ("/bg", or "" at the root): the step is also served at <folder> + its path. */
  folder: string;
  upsellPages: UpsellPageOption[];
  /** The funnel's uploaded videos and the files still being sent (the VSL stage shows this group's). */
  videos: UpsellVideo[];
  uploads: UploadProgress[];
  onUpload: (file: File) => void;
  onRetryVideo: (id: number) => void;
  onDismissUpload: (key: string) => void;
  checkout: Record<string, string>;
  served: UpsellServed[];
  answerRows: UpsellAnswer[];
  revenueRows: UpsellRevenue[];
  stage: Stage;
  onStage: (s: Stage) => void;
  editingFlow: string | null;
  onEditFlow: (id: string | null) => void;
  update: Update;
  /** After the group left the step: select another of the step's groups (null = the step is gone). */
  onSelectGroup: (id: string | null) => void;
  funnelId: string;
  /** "+ New upsell page": its sources, and the page it created (the editor lists it). */
  templates: { id: string; name: string }[];
  copySources: UpsellCopySource[];
  onPageCreated: (page: UpsellPageOption) => void;
  /** Opens the group's route (its name and fronts are the route's, set in every step at once). */
  onEditRoute: (key: string) => void;
}) {
  const [newPageFlow, setNewPageFlow] = useState<string | null>(null);
  const stepOrigin = origin(step.id);
  // An uploaded video's player id → its file's name (shown next to the VSL's id).
  const videoNames = new Map(videos.filter((v) => v.player_id).map((v) => [v.player_id as string, v.name]));
  const keys = Object.keys(checkout).sort();
  // A new offer starts on the step's own key (up3, then up3_dw for a downsell) when the product has it.
  const offerKey = keys.includes(step.id) ? step.id : (keys[0] ?? step.id);
  const downsellKey = keys.find((k) => k === `${step.id}_dw`) ?? keys.find((k) => k.startsWith(`${step.id}_`)) ?? offerKey;
  const groupOf = (c: UpsellConfig) => c.steps.find((s) => s.id === step.id)?.groups?.find((g) => g.id === group.id);
  const mut = (fn: (g: UpsellGroup, c: UpsellConfig) => void) =>
    update((c) => {
      const g = groupOf(c);
      if (g) fn(g, c);
    });
  const shares = flowShares(served, step.id, group.id, config.flows.map((f) => f.id));
  const groupVisits = visits(served, { step: step.id, grp: group.id });
  const pageHeaderCells = ["Visits", "Accepted", "Declined", "Take rate", "Revenue", "$/visit"];
  // A page version opens in the page editor (new tab, so the draft here stays as it is), from this group.
  const pageHref = (pageId: string, preview: boolean) => `/upsells/${funnelId}/pages/${pageId}?step=${step.id}&group=${group.id}${preview ? "&preview=1" : ""}`;

  const keySelect = (value: string, onChange: (k: string) => void, label: string) => (
    <>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={`${SELECT_BASE} w-44 shrink-0 font-mono`}>
        {!keys.includes(value) ? <option value={value}>{value || "choose…"}</option> : null}
        {keys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <span className="max-w-40 truncate font-mono text-xs text-muted" title={checkout[value] ?? ""}>
        {checkout[value] ?? "no value on this platform"}
      </span>
    </>
  );

  const flowHeader = (flow: UpsellFlow | null, index: number) => {
    const id = flow?.id ?? DEFAULT_FLOW;
    const chips = flow ? ruleChips(flow.when) : [];
    const share = shares.get(id);
    return (
      <div className="flex border-y border-border bg-foreground/[0.03]">
        <div className={`${LEFT} flex flex-wrap items-center gap-2 px-4 py-2`}>
          <span className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-bold text-white ${flow ? "bg-accent" : "bg-zinc-500"}`}>{flow ? index + 1 : "—"}</span>
          <b className="text-xs uppercase tracking-wider">{flow?.name ?? "Default"}</b>
          {flow ? (
            chips.length ? (
              chips.map((c) => (
                <span key={c} className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
                  {c}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted">every buyer</span>
            )
          ) : (
            <span className="text-xs text-muted">everyone no flow took</span>
          )}
          {flow ? (
            <span className="ml-auto flex items-center gap-1">
              <button type="button" aria-label="Move flow up" disabled={index === 0} onClick={() => update((c) => { const i = c.flows.findIndex((f) => f.id === id); if (i > 0) [c.flows[i - 1], c.flows[i]] = [c.flows[i], c.flows[i - 1]]; })} className="size-8 rounded-md text-muted hover:bg-foreground/5 disabled:opacity-30">↑</button>
              <button type="button" aria-label="Move flow down" disabled={index === config.flows.length - 1} onClick={() => update((c) => { const i = c.flows.findIndex((f) => f.id === id); if (i >= 0 && i < c.flows.length - 1) [c.flows[i], c.flows[i + 1]] = [c.flows[i + 1], c.flows[i]]; })} className="size-8 rounded-md text-muted hover:bg-foreground/5 disabled:opacity-30">↓</button>
              <button type="button" onClick={() => onEditFlow(editingFlow === id ? null : id)} className={`rounded-lg border px-2.5 py-1 text-xs font-semibold text-accent ${editingFlow === id ? "border-accent" : "border-border"}`}>
                Edit rule
              </button>
              <button
                type="button"
                aria-label="Delete flow"
                onClick={() =>
                  update((c) => {
                    c.flows = c.flows.filter((f) => f.id !== id);
                    for (const s of c.steps) for (const g of s.groups ?? []) delete g.pages[id];
                  })
                }
                className="size-8 rounded-md text-muted hover:bg-foreground/5"
              >
                ×
              </button>
            </span>
          ) : null}
        </div>
        <div className="flex flex-1 items-center px-4 text-xs text-muted">
          {share && groupVisits > 0 ? (
            <span>
              <b className="text-foreground">{share.share}</b> of this group&apos;s buyers · {fmtInt(share.visits)} visits
            </span>
          ) : (
            <span>no visits in the period</span>
          )}
        </div>
      </div>
    );
  };

  const pageRows = (flowId: string) => {
    const list = group.pages[flowId] ?? [];
    return (
      <>
        {list.length === 0 && flowId !== DEFAULT_FLOW ? <div className="border-b border-border/60 px-4 py-2.5 text-sm text-muted">No pages of its own: this flow gets Default&apos;s pages.</div> : null}
        {list.map((v, i) => {
          const acc = answers(answerRows, { origin: stepOrigin, kind: "accept", grp: group.id, flow: flowId, page: v.page_id });
          const dec = answers(answerRows, { origin: stepOrigin, kind: "decline", grp: group.id, flow: flowId, page: v.page_id });
          const vis = visits(served, { step: step.id, grp: group.id, flow: flowId, page: v.page_id });
          // The page's sales: its offer and its downsells (they run on the same page).
          const sold = revenue(revenueRows, { step: step.id, grp: group.id, flow: flowId, page: v.page_id });
          const known = upsellPages.some((p) => p.id === v.page_id);
          return (
            <Row
              key={i}
              left={
                <>
                  <span className="size-2.5 rounded-full bg-emerald-600" aria-hidden="true" />
                  <select aria-label="Page version" value={v.page_id} onChange={(e) => mut((g) => { g.pages[flowId][i].page_id = e.target.value; })} className={`${SELECT_BASE} w-56 shrink-0`}>
                    {!upsellPages.some((p) => p.id === v.page_id) ? <option value={v.page_id}>Missing page</option> : null}
                    {upsellPages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.status === "DRAFT" ? " (draft)" : ""}
                      </option>
                    ))}
                  </select>
                  <Share value={v.weight} label="Share" onChange={(n) => mut((g) => { g.pages[flowId][i].weight = n; })} />
                  {known ? (
                    <span className="flex gap-1">
                      <a href={pageHref(v.page_id, false)} target="_blank" rel="noopener" className="inline-flex min-h-8 items-center rounded-md px-2 text-xs font-semibold text-accent hover:bg-accent/10">
                        Edit
                      </a>
                      <a href={pageHref(v.page_id, true)} target="_blank" rel="noopener" className="inline-flex min-h-8 items-center rounded-md px-2 text-xs font-semibold text-accent hover:bg-accent/10">
                        Preview
                      </a>
                    </span>
                  ) : null}
                  <Remove label="Remove version" onClick={() => mut((g) => { g.pages[flowId].splice(i, 1); if (g.pages[flowId].length === 0 && flowId !== DEFAULT_FLOW) delete g.pages[flowId]; })} />
                </>
              }
              cells={[
                fmtInt(vis),
                fmtInt(acc),
                fmtInt(dec),
                fmtPct(acc, vis),
                <RevenueText key="r" exact={sold.revenue} estimated={sold.estimated} />,
                <PerVisitText key="v" exact={sold.revenue} estimated={sold.estimated} visits={vis} />,
              ]}
            />
          );
        })}
        <div className="flex items-center gap-4 border-b border-border/60 px-4 py-1">
          <AddButton
            disabled={list.length >= MAX_VERSIONS || upsellPages.length === 0}
            onClick={() =>
              mut((g) => {
                // The next upsell page not in this list yet (else the first).
                const next = upsellPages.find((p) => !list.some((v) => v.page_id === p.id)) ?? upsellPages[0];
                g.pages[flowId] = [...(g.pages[flowId] ?? []), { page_id: next.id, weight: list.length === 0 ? 100 : 0 }];
              })
            }
          >
            + Page version
          </AddButton>
          <AddButton disabled={list.length >= MAX_VERSIONS || newPageFlow === flowId} onClick={() => setNewPageFlow(flowId)}>
            + New upsell page
          </AddButton>
          <Total list={list} />
          {upsellPages.length === 0 ? <span className="text-xs text-muted">No upsell pages for this product and platform.</span> : null}
        </div>
        {newPageFlow === flowId ? (
          <NewUpsellPage
            funnelId={funnelId}
            defaultName={`${STEP_LABELS[step.id]} · ${group.name}`}
            templates={templates}
            copySources={copySources}
            onCancel={() => setNewPageFlow(null)}
            onCreated={(page) => {
              onPageCreated(page);
              // The new page joins this flow's versions (all of the traffic when it is the first).
              mut((g) => {
                const now = g.pages[flowId] ?? [];
                g.pages[flowId] = [...now, { page_id: page.id, weight: now.length === 0 ? 100 : 0 }];
              });
              setNewPageFlow(null);
            }}
          />
        ) : null}
      </>
    );
  };

  return (
    <section aria-label={`${STEP_LABELS[step.id]} · ${group.name}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="text-lg font-semibold">
          {STEP_LABELS[step.id]} · {group.name}
        </h2>
        <span className="font-mono text-sm text-muted">{stepPaths(step.slug, folder, step.aliases).join(" · ")}</span>
        <span className="font-mono text-sm text-muted">{group.fronts.length ? `came with ${group.fronts.join(", ")}` : "any other front"}</span>
        <span className="ml-auto flex gap-3">
          <AddButton onClick={() => onEditRoute(routeKey(group.fronts))}>Edit route</AddButton>
          <button
            type="button"
            disabled={(step.groups?.length ?? 0) <= 1}
            title={(step.groups?.length ?? 0) <= 1 ? "The step's only route" : `${group.name} gets the step's fallback here`}
            onClick={() => {
              update((c) => void routeRemoveFromStep(c, routeKey(group.fronts), step.id));
              onSelectGroup(null);
            }}
            className="min-h-10 px-1 text-sm font-semibold text-red-600 disabled:opacity-30 dark:text-red-400"
          >
            Remove from this step
          </button>
          <button
            type="button"
            onClick={() => {
              update((c) => {
                c.steps = c.steps.filter((x) => x.id !== step.id);
              });
              onSelectGroup(null);
            }}
            className="min-h-10 px-1 text-sm font-semibold text-red-600 dark:text-red-400"
          >
            Remove step
          </button>
        </span>
      </div>

      <StepAliases config={config} step={step} folder={folder} update={update} />

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <div className="min-w-max">
        <div className="flex border-b border-border">
          <div className={`${LEFT} flex items-center gap-1 px-4 py-3`} role="tablist" aria-label="Stage">
            {STAGES.map((s, i) => (
              <span key={s.id} className="flex items-center gap-1">
                {i > 0 ? <span aria-hidden="true" className="px-1 text-muted">›</span> : null}
                <button
                  type="button"
                  role="tab"
                  aria-selected={stage === s.id}
                  onClick={() => onStage(s.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${stage === s.id ? "bg-accent font-semibold text-white" : "font-medium text-foreground/80 hover:bg-foreground/5"}`}
                >
                  {s.label}
                </button>
              </span>
            ))}
            <span className="ml-auto text-sm font-semibold text-foreground/80">Share</span>
          </div>
          <div className="flex flex-1 items-center">
            {(stage === "vsl" ? ["Visits"] : stage === "downsell" ? ["Accepted", "Declined", "Revenue"] : pageHeaderCells).map((h) => (
              <div key={h} className={`${CELL} py-3 font-semibold text-foreground/80`}>
                {h}
              </div>
            ))}
          </div>
        </div>

        {stage === "page" ? (
          <>
            {config.flows.map((f, i) => (
              <div key={f.id}>
                {flowHeader(f, i)}
                {editingFlow === f.id ? (
                  <RuleEditor
                    flow={f}
                    onClose={() => onEditFlow(null)}
                    onChange={(next) => update((c) => { const j = c.flows.findIndex((x) => x.id === f.id); if (j >= 0) c.flows[j] = next; })}
                  />
                ) : null}
                {pageRows(f.id)}
              </div>
            ))}
            {flowHeader(null, config.flows.length)}
            {pageRows(DEFAULT_FLOW)}
            <div className="px-4 py-1">
              <AddButton
                disabled={config.flows.length >= MAX_FLOWS}
                onClick={() => {
                  const id = newId("f");
                  update((c) => {
                    c.flows.push({ id, name: `VSL flow ${c.flows.length + 1}`, when: { cookies: { vsl_ok: "present" } } });
                  });
                  onEditFlow(id);
                }}
              >
                + New flow
              </AddButton>
            </div>
          </>
        ) : null}

        {stage === "vsl" ? (
          <>
            {(group.vsls ?? []).map((v, i) => (
              <Row
                key={i}
                left={
                  <>
                    <input aria-label="VTurb video id" value={v.id} placeholder="VTurb video id" onChange={(e) => mut((g) => { if (g.vsls) g.vsls[i].id = e.target.value.trim(); })} className={`${INPUT_CLASS} w-64 font-mono`} />
                    {videoNames.get(v.id) ? <span className="max-w-40 truncate text-xs text-muted">{videoNames.get(v.id)}</span> : null}
                    <Share value={v.weight} label="Share" onChange={(n) => mut((g) => { if (g.vsls) g.vsls[i].weight = n; })} />
                    <Remove label="Remove video" onClick={() => mut((g) => { g.vsls?.splice(i, 1); })} />
                  </>
                }
                cells={[fmtInt(visits(served, { step: step.id, grp: group.id, video: v.id }))]}
              />
            ))}
            <div className="flex items-center gap-4 px-4 py-1">
              <AddButton disabled={(group.vsls?.length ?? 0) >= MAX_VERSIONS} onClick={() => mut((g) => { g.vsls = [...(g.vsls ?? []), { id: "", weight: (g.vsls?.length ?? 0) === 0 ? 100 : 0 }]; })}>
                + VSL
              </AddButton>
              <Total list={group.vsls ?? []} />
            </div>
            <VslUploads
              uploads={uploads.filter((u) => u.step === step.id && u.group === group.id)}
              videos={videos.filter((v) => v.step === step.id && v.group_id === group.id)}
              onUpload={onUpload}
              onRetry={onRetryVideo}
              onDismiss={onDismissUpload}
            />
          </>
        ) : null}

        {stage === "cta" ? (
          <>
            {(group.offers ?? []).map((o, i) => {
              const code = checkout[o.offer] ?? "";
              const vis = visits(served, { step: step.id, grp: group.id, offer: o.offer });
              const sold = revenue(revenueRows, { step: step.id, downsell: false, grp: group.id, offer: code });
              const acc = answers(answerRows, { origin: stepOrigin, kind: "accept", grp: group.id, offer: code });
              const dec = answers(answerRows, { origin: stepOrigin, kind: "decline", grp: group.id, offer: code });
              return (
                <Row
                  key={i}
                  left={
                    <>
                      {keySelect(o.offer, (k) => mut((g) => { if (g.offers) g.offers[i].offer = k; }), "Offer")}
                      <Share value={o.weight} label="Share" onChange={(n) => mut((g) => { if (g.offers) g.offers[i].weight = n; })} />
                      <Remove label="Remove offer" onClick={() => mut((g) => { g.offers?.splice(i, 1); })} />
                    </>
                  }
                  cells={[
                    fmtInt(vis),
                    fmtInt(acc),
                    fmtInt(dec),
                    fmtPct(acc, vis),
                    <RevenueText key="r" exact={sold.revenue} estimated={sold.estimated} />,
                    <PerVisitText key="v" exact={sold.revenue} estimated={sold.estimated} visits={vis} />,
                  ]}
                />
              );
            })}
            <div className="flex items-center gap-4 px-4 py-1">
              <AddButton disabled={(group.offers?.length ?? 0) >= MAX_VERSIONS} onClick={() => mut((g) => { g.offers = [...(g.offers ?? []), { offer: offerKey, weight: (g.offers?.length ?? 0) === 0 ? 100 : 0 }]; })}>
                + Offer
              </AddButton>
              <Total list={group.offers ?? []} />
              <span className="text-xs text-muted">The page charges it where it writes {"{{upsell.offer}}"}.</span>
            </div>
          </>
        ) : null}

        {stage === "downsell" ? (
          <>
            {(group.downsells ?? []).map((slot, si) => (
              <div key={si}>
                <div className="flex items-center gap-2 border-y border-border bg-foreground/[0.03] px-4 py-2 text-xs">
                  <b className="uppercase tracking-wider">Downsell {si + 1}</b>
                  <span className="text-muted">
                    when the buyer tries to leave or goes back{si === 0 ? "" : ` after Downsell ${si}`}, on the same page · {"{{upsell.downsell" + (si + 1) + "}}"}
                  </span>
                  <button type="button" onClick={() => mut((g) => { g.downsells?.splice(si, 1); })} className="ml-auto font-semibold text-red-600 dark:text-red-400">
                    Remove
                  </button>
                </div>
                {slot.map((o, i) => {
                  const code = checkout[o.offer] ?? "";
                  const ds = origin(step.id, si + 1);
                  const sold = revenue(revenueRows, { step: step.id, slot: si + 1, grp: group.id, offer: code });
                  return (
                    <Row
                      key={i}
                      left={
                        <>
                          {keySelect(o.offer, (k) => mut((g) => { if (g.downsells) g.downsells[si][i].offer = k; }), `Downsell ${si + 1} offer`)}
                          <Share value={o.weight} label="Share" onChange={(n) => mut((g) => { if (g.downsells) g.downsells[si][i].weight = n; })} />
                          <Remove label="Remove version" onClick={() => mut((g) => { g.downsells?.[si].splice(i, 1); if (g.downsells?.[si].length === 0) g.downsells.splice(si, 1); })} />
                        </>
                      }
                      cells={[
                        fmtInt(answers(answerRows, { origin: ds, kind: "accept", downsell: true, grp: group.id, offer: code })),
                        fmtInt(answers(answerRows, { origin: ds, kind: "decline", downsell: true, grp: group.id, offer: code })),
                        <RevenueText key="r" exact={sold.revenue} estimated={sold.estimated} />,
                      ]}
                    />
                  );
                })}
                <div className="flex items-center gap-4 border-b border-border/60 px-4 py-1">
                  <AddButton disabled={slot.length >= MAX_VERSIONS} onClick={() => mut((g) => { g.downsells?.[si].push({ offer: downsellKey, weight: 0 }); })}>
                    + Version
                  </AddButton>
                  <Total list={slot} />
                </div>
              </div>
            ))}
            <div className="px-4 py-1">
              <AddButton disabled={(group.downsells?.length ?? 0) >= MAX_DOWNSELLS} onClick={() => mut((g) => { g.downsells = [...(g.downsells ?? []), [{ offer: downsellKey, weight: 100 }]]; })}>
                + Downsell
              </AddButton>
            </div>
          </>
        ) : null}
        </div>
      </div>
    </section>
  );
}
