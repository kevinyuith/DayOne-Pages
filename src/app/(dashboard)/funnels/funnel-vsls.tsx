"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { PlusIcon } from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { INPUT_BASE } from "@/components/ui/field";
import type { FunnelVideo, FunnelVsl, FunnelVslPanel, ProducedVsl, VslStatus } from "@/lib/pages/queries";
import { evenSplit } from "@/lib/pages/traffic";
import { findFunnelVideo, loadFunnelVsls, saveFunnelVsl, searchFunnelVsls } from "./actions";

/**
 * A funnel's VSLs tab (inside its row on the Funnel screen), loaded when it
 * opens: the funnel's VTurb A/B test (the replica in pages.funnels.vsl) —
 * each video (VTurb player id) with its share, editable; the shares add up to
 * 100 and saving writes the test in VTurb. VSLs are added searching the
 * produced ones (or by VTurb video id). A funnel without a test shows the
 * VSLs linked to it in dayone-main.
 */

const STATUS_LABELS: Record<VslStatus, string> = {
  VALIDATED: "Validated",
  VALIDATION: "Validation",
  STAND_BY: "Stand by",
  PAUSED: "Paused",
  DISCARDED: "Discarded",
};
const STATUS_TONE: Record<VslStatus, "success" | "warning" | "neutral" | "danger" | "info"> = {
  VALIDATED: "success",
  VALIDATION: "info",
  STAND_BY: "neutral",
  PAUSED: "warning",
  DISCARDED: "danger",
};

/** Seconds as m:ss. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

type Message = { tone: "danger" | "success"; text: string };

export function FunnelVslsPanel({ mainFunnelId, label }: { mainFunnelId: string; label: string }) {
  const [panel, setPanel] = useState<FunnelVslPanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const load = useCallback(async () => {
    const r = await loadFunnelVsls(mainFunnelId);
    if (r.ok) {
      setPanel(r.panel);
      setError(null);
    } else {
      setError(r.reason);
    }
  }, [mainFunnelId]);

  useEffect(() => {
    let live = true;
    loadFunnelVsls(mainFunnelId).then((r) => {
      if (!live) return;
      if (r.ok) setPanel(r.panel);
      else setError(r.reason);
    });
    return () => {
      live = false;
    };
  }, [mainFunnelId]);

  if (error && !panel) return <Alert tone="danger">{error}</Alert>;
  if (!panel) return <p className="py-2 text-sm text-muted">Loading…</p>;
  if (!panel.groupId) return <LinkedVsls vsls={panel.linked} />;
  return (
    <div className="flex flex-col gap-3">
      <VturbTest
        // The key restarts the editor when a new replica arrives.
        key={`${panel.syncedAt}:${panel.videos.map((v) => `${v.id}=${v.weight}`).join()}`}
        funnelRowId={panel.funnelRowId}
        label={label}
        videos={panel.videos}
        onDone={async (m) => {
          setMessage(m);
          await load();
        }}
      />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </div>
  );
}

/** The VSL columns of a row (status, language, pitch, copy, editor). */
function VslCells({ vsl }: { vsl: FunnelVsl | null }) {
  return (
    <>
      <td className="px-3 py-2">{vsl?.status ? <Badge tone={STATUS_TONE[vsl.status]}>{STATUS_LABELS[vsl.status]}</Badge> : <span className="text-muted">—</span>}</td>
      <td className="px-3 py-2 text-muted">{vsl?.language ?? "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted">{vsl?.pitch ? clock(vsl.pitch) : "—"}</td>
      <td className="px-3 py-2 text-muted">{vsl?.copywriter ?? "—"}</td>
      <td className="px-3 py-2 text-muted">{vsl?.editor ?? "—"}</td>
    </>
  );
}

function Title({ text, url }: { text: string; url: string | null }) {
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium hover:text-accent" title="Play the video">
      <span aria-hidden className="text-xs text-accent">
        ▶
      </span>
      {text}
    </a>
  ) : (
    <span className="font-medium">{text}</span>
  );
}

/**
 * The funnel's VTurb A/B test: one row per video, with its share. Edit the
 * shares (they must add up to 100%), add VSLs, then Save: it writes the test
 * in VTurb and reports back through `onDone` (which reloads the replica).
 * Videos without traffic are folded under "Show all".
 */
function VturbTest({
  funnelRowId,
  label,
  videos,
  onDone,
}: {
  funnelRowId: string;
  label: string;
  videos: FunnelVideo[];
  onDone: (message: Message) => Promise<void>;
}) {
  const original = useMemo(() => Object.fromEntries(videos.map((v) => [v.id, v.weight])), [videos]);
  const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries(videos.map((v) => [v.id, String(v.weight)])));
  const [added, setAdded] = useState<FunnelVideo[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ProducedVsl[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSearch = useRef("");
  const [pending, start] = useTransition();
  const [finding, startFind] = useTransition();

  const num = (id: string) => {
    const n = Number((weights[id] ?? "").replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  };
  // The videos come highest share first (by the % loaded: the rows don't jump while typing); new ones go last.
  const all = [...videos, ...added];
  const total = all.reduce((t, v) => t + (Number.isNaN(num(v.id)) ? 0 : num(v.id)), 0);
  const changed = added.length > 0 || videos.some((v) => num(v.id) !== v.weight);
  const valid = all.every((v) => !Number.isNaN(num(v.id)) && num(v.id) >= 0 && num(v.id) <= 100) && Math.abs(total - 100) < 0.001;
  const visible = showAll ? all : all.filter((v) => added.includes(v) || v.weight > 0 || num(v.id) > 0);
  const hidden = all.length - visible.length;

  const onSave = () =>
    start(async () => {
      const r = await saveFunnelVsl(funnelRowId, Object.fromEntries(all.map((v) => [v.id, num(v.id)])), original);
      // Both ways the replica may have changed (saved, or re-read from VTurb on a conflict): reload it.
      await onDone(r.ok ? { tone: "success", text: "Saved in VTurb." } : { tone: "danger", text: r.reason });
    });
  const inTest = (id: string) => all.some((v) => v.id === id);
  /** Puts a video in the list as NEW, at 0% (it joins the test on Save, with a share). */
  const addVideo = (video: FunnelVideo) => {
    setAdded((cur) => [...cur, video]);
    setWeights((cur) => ({ ...cur, [video.id]: "0" }));
    closeAdd();
  };
  const onAdd = () =>
    startFind(async () => {
      setAddError(null);
      const id = newId.trim().toLowerCase();
      if (inTest(id)) return setAddError("This video is already in the test.");
      const r = await findFunnelVideo(id);
      if (!r.ok) return setAddError(r.reason);
      addVideo({ id: r.id, name: r.name, weight: 0, vsl: null });
    });
  const onSearch = (value: string) => {
    setSearch(value);
    lastSearch.current = value;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.trim().length < 2) {
      setResults(null);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const r = await searchFunnelVsls(value);
      if (lastSearch.current !== value) return; // a newer search is on its way
      setSearching(false);
      if (r.ok) setResults(r.vsls);
      else setAddError(r.reason);
    }, 300);
  };
  const closeAdd = () => {
    setAdding(false);
    setNewId("");
    setAddError(null);
    setSearch("");
    setResults(null);
    setSearching(false);
    lastSearch.current = "";
  };
  const onEven = () => {
    const active = all.filter((v) => num(v.id) > 0).map((v) => v.id);
    const even = evenSplit(active.length ? active : all.map((v) => v.id));
    setWeights(Object.fromEntries(all.map((v) => [v.id, String(even[v.id] ?? 0)])));
  };
  const onReset = () => {
    setAdded([]);
    setWeights(Object.fromEntries(videos.map((v) => [v.id, String(v.weight)])));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted">
            <tr>
              <th className="w-px px-3 py-2 font-medium">Traffic</th>
              <th className="px-3 py-2 font-medium">Video</th>
              <th className="px-3 py-2 font-medium">Video ID</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Language</th>
              <th className="px-3 py-2 text-right font-medium">Pitch</th>
              <th className="px-3 py-2 font-medium">Copy</th>
              <th className="px-3 py-2 font-medium">Editor</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((v) => {
              const isNew = added.includes(v);
              const edited = !isNew && num(v.id) !== v.weight;
              return (
                <tr key={v.id} className={`border-b border-border last:border-0 ${isNew ? "bg-accent/5" : ""}`}>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="inline-flex items-center gap-1">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={weights[v.id] ?? ""}
                        onChange={(e) => setWeights((cur) => ({ ...cur, [v.id]: e.target.value }))}
                        aria-label={`Traffic of ${v.name ?? v.id}`}
                        className={`${INPUT_BASE} h-8 w-16 px-2 text-right tabular-nums ${edited ? "border-accent/60" : ""}`}
                      />
                      <span className="text-xs text-muted">%</span>
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Title text={v.vsl?.title ?? v.name ?? "Untitled"} url={v.vsl?.videoUrl ?? null} />
                    {isNew ? <span className="ml-2 rounded bg-accent/15 px-1 text-[10px] font-semibold uppercase text-accent">New</span> : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted">{v.id}</td>
                  <VslCells vsl={v.vsl} />
                </tr>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-3 text-sm text-muted">
                  No video with traffic.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {hidden > 0 || showAll ? (
          <button type="button" onClick={() => setShowAll((s) => !s)} className="w-full border-t border-border px-3 py-2 text-left text-xs font-medium text-accent hover:bg-foreground/[0.03]">
            {showAll ? "Show only videos with traffic" : `Show all (${hidden} more at 0%)`}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => setAdding(true)} disabled={pending} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline disabled:opacity-50">
          <PlusIcon className="size-3.5" /> Add VSL
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs tabular-nums ${Math.abs(total - 100) < 0.001 ? "text-muted" : "font-semibold text-red-600 dark:text-red-400"}`}>Total {pct(total)}</span>
          <Button type="button" size="sm" variant="ghost" onClick={onEven} disabled={pending}>
            Split evenly
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onReset} disabled={pending || !changed}>
            Reset
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={pending || !changed || !valid}>
            {pending ? "Saving…" : "Save in VTurb"}
          </Button>
        </div>
      </div>

      <Dialog open={adding} title={`Add VSL · ${label}`} onClose={closeAdd} className="sm:max-w-2xl">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Search the produced VSLs</span>
            <input value={search} onChange={(e) => onSearch(e.target.value)} autoFocus placeholder="Name, copywriter or editor…" className={`${INPUT_BASE} w-full`} />
          </label>
          {searching ? <p className="text-xs text-muted">Searching…</p> : null}
          {results && !searching ? (
            results.length ? (
              <ul className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {results.map((v) => {
                  const already = v.videoId ? inTest(v.videoId) : false;
                  return (
                    <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{v.title}</p>
                        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                          {v.status ? <Badge tone={STATUS_TONE[v.status]}>{STATUS_LABELS[v.status]}</Badge> : null}
                          {v.language ? <span>{v.language}</span> : null}
                          {v.pitch ? <span>pitch {clock(v.pitch)}</span> : null}
                          <span className="font-mono">{v.videoId ?? "no VTurb video"}</span>
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={!v.videoId || already}
                        onClick={() => v.videoId && addVideo({ id: v.videoId, name: v.title, weight: 0, vsl: v })}
                      >
                        {already ? "In the test" : "Add"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-muted">No produced VSL matches.</p>
            )
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              onAdd();
            }}
            className="flex flex-col gap-1.5 border-t border-border pt-4"
          >
            <span className="text-xs font-medium text-muted">Or paste a VTurb video ID</span>
            <div className="flex gap-2">
              <input value={newId} onChange={(e) => setNewId(e.target.value)} aria-label="VTurb video ID" spellCheck={false} className={`${INPUT_BASE} w-full font-mono text-sm`} />
              <Button type="submit" variant="secondary" disabled={finding || !newId.trim()}>
                {finding ? "Adding…" : "Add"}
              </Button>
            </div>
          </form>
          {addError ? <Alert tone="danger">{addError}</Alert> : null}
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={closeAdd}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/** A funnel without a VTurb A/B test: the VSLs linked to it in dayone-main (read-only). */
function LinkedVsls({ vsls }: { vsls: FunnelVsl[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">No VTurb A/B test.</p>
      {vsls.length ? (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">VSL</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Language</th>
                <th className="px-3 py-2 text-right font-medium">Pitch</th>
                <th className="px-3 py-2 font-medium">Copy</th>
                <th className="px-3 py-2 font-medium">Editor</th>
              </tr>
            </thead>
            <tbody>
              {vsls.map((v) => (
                <tr key={v.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <Title text={v.title} url={v.videoUrl} />
                  </td>
                  <VslCells vsl={v} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
