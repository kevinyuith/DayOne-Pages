"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CodeEditor } from "@/components/code-editor";
import { CodeIcon, DownloadIcon, SparklesIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { INPUT_CLASS, TEXTAREA_CLASS } from "@/components/ui/field";
import type { ActionResult } from "@/lib/action-result";
import { importHtml } from "@/lib/pages/import-html";
import { cssProblem, htmlProblem, joinSource, splitSource, type SourceParts } from "@/lib/pages/source-split";
import { isFullDocument } from "@/lib/pages/starter-template";

/**
 * "Code" panel (the reference builder's "Source code"): the slug's HTML split
 * into HTML, Page CSS and Base CSS (see source-split.ts), each in its own
 * editor, beside the canvas.
 *
 * The editors hold drafts. With **Live updates** on, a draft goes into the page
 * 400 ms after the last keystroke (unless it looks unfinished — a tag or brace
 * left open); off, only **Apply Page** puts them in. A CSS-only change reaches
 * the canvas without reloading it. When the page changes elsewhere (canvas,
 * undo), an editor without unapplied edits follows it; one with edits keeps
 * them until they are applied.
 *
 * Kept mounted while the editor is open (hidden when another panel is showing),
 * so drafts and each editor's undo history survive switching panels.
 */

type Key = keyof SourceParts;
const KEYS: Key[] = ["html", "pageCss", "baseCss"];
const TITLES: Record<Key, string> = { html: "HTML", pageCss: "Page CSS", baseCss: "Base CSS" };
const HINTS: Record<Key, string> = {
  html: "The page without its CSS. Each <style> that stays here holds a /* Base CSS #N */ marker: its CSS is in Base CSS.",
  pageCss: "The page's own CSS. It comes last in <head>, so it wins over the Base CSS.",
  baseCss: "The CSS the page came with: the content of its <style> tags, in page order.",
};

const LIVE_DEBOUNCE_MS = 400;
const APPLIED_MS = 1500;

export type CodeAiEdit = (input: {
  kind: "html" | "css";
  code: string;
  instructions: string;
  context: string | null;
}) => Promise<ActionResult<{ code: string }>>;

// ── "Live updates": a per-browser preference ───────────────────────────────
const LIVE_KEY = "dop.editor.live-updates";
let liveMemory: boolean | null = null;
const liveListeners = new Set<() => void>();
function readLive(): boolean {
  if (liveMemory !== null) return liveMemory;
  try {
    return window.localStorage.getItem(LIVE_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeLive(on: boolean) {
  liveMemory = on;
  try {
    window.localStorage.setItem(LIVE_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  liveListeners.forEach((l) => l());
}
function subscribeLive(listener: () => void) {
  liveListeners.add(listener);
  return () => void liveListeners.delete(listener);
}

export function SourcePanel({
  content,
  onApply,
  onPendingChange,
  fileName,
  placeholderValues,
  aiEdit,
}: {
  content: string;
  /** Puts a new version of the slug's HTML into the editor (undo history, canvas). */
  onApply: (next: string) => void;
  /** True while some editor holds edits not yet in the page (the leave guard counts them). */
  onPendingChange?: (pending: boolean) => void;
  /** Export file name, without the extension. */
  fileName: string;
  placeholderValues: Record<string, string> | null;
  aiEdit: CodeAiEdit;
}) {
  const live = useSyncExternalStore(subscribeLive, readLive, () => true);
  const parts = useMemo(() => splitSource(content), [content]);

  // Drafts follow the page for every editor that has no unapplied edits.
  const [seen, setSeen] = useState(parts);
  const [draft, setDraft] = useState(parts);
  if (seen !== parts) {
    setSeen(parts);
    setDraft({
      html: draft.html === seen.html ? parts.html : draft.html,
      pageCss: draft.pageCss === seen.pageCss ? parts.pageCss : draft.pageCss,
      baseCss: draft.baseCss === seen.baseCss ? parts.baseCss : draft.baseCss,
    });
  }
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const pending = KEYS.some((k) => draft[k] !== parts[k]);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);

  const fullDoc = isFullDocument(content);
  /** Why a draft would not be applied live (null = fine, or unchanged). */
  const problems = useMemo<Record<Key, string | null>>(
    () => ({
      html:
        draft.html === parts.html
          ? null
          : fullDoc && !isFullDocument(draft.html)
            ? "The HTML must stay a complete document (starting with <!doctype html> or <html>)."
            : htmlProblem(draft.html, parts.html),
      pageCss: draft.pageCss === parts.pageCss ? null : cssProblem(draft.pageCss, parts.pageCss),
      baseCss: draft.baseCss === parts.baseCss ? null : cssProblem(draft.baseCss, parts.baseCss),
    }),
    [draft, parts, fullDoc],
  );

  const [applied, setApplied] = useState<Key[]>([]);
  const appliedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  /** Puts the drafts of `keys` into the page (the others stay as the page has them). */
  const applyKeys = useCallback(
    (keys: Key[]) => {
      if (!keys.length) return;
      const merged = { ...parts };
      for (const k of keys) merged[k] = draft[k];
      const next = joinSource(merged);
      const nextParts = splitSource(next);
      onApply(next);
      setDraft((d) => {
        const out = { ...d };
        for (const k of keys) out[k] = nextParts[k];
        return out;
      });
      setApplied(keys);
      clearTimeout(appliedTimer.current);
      appliedTimer.current = setTimeout(() => setApplied([]), APPLIED_MS);
    },
    [draft, parts, onApply],
  );
  useEffect(() => () => clearTimeout(appliedTimer.current), []);

  // Live updates: what changed and doesn't look unfinished goes in after a pause in typing.
  const liveKeys = KEYS.filter((k) => draft[k] !== parts[k] && !problems[k]).join(",");
  useEffect(() => {
    if (!live || !liveKeys) return;
    const t = setTimeout(() => applyKeys(liveKeys.split(",") as Key[]), LIVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [live, liveKeys, applyKeys]);

  const applyAll = () => {
    setNotice(null);
    if (problems.html && fullDoc && !isFullDocument(draft.html)) return setNotice(problems.html);
    applyKeys(KEYS.filter((k) => draft[k] !== parts[k]));
  };

  /** Replaces the whole page (import) — every editor takes the result. */
  const applyWhole = (next: string) => {
    onApply(next);
    setDraft(splitSource(next));
    setApplied([...KEYS]);
    clearTimeout(appliedTimer.current);
    appliedTimer.current = setTimeout(() => setApplied([]), APPLIED_MS);
  };

  const exportPage = () => {
    const url = URL.createObjectURL(new Blob([joinSource(draft)], { type: "text/html;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const [bigEditor, setBigEditor] = useState<Key | null>(null);
  const [aiFor, setAiFor] = useState<"html" | "pageCss" | null>(null);
  const [importing, setImporting] = useState(false);

  const runAi = async (k: "html" | "pageCss", instructions: string): Promise<ActionResult> => {
    const sent = draftRef.current[k];
    const r = await aiEdit({ kind: k === "html" ? "html" : "css", code: sent, instructions, context: k === "pageCss" ? draftRef.current.html : null });
    if (!r.ok) return r;
    if (draftRef.current[k] !== sent) setNotice("AI result discarded — the page changed during generation.");
    else {
      setNotice(null);
      setDraft((d) => ({ ...d, [k]: r.code }));
    }
    return { ok: true };
  };

  const status = (k: Key): { text: string; title?: string; tone: string } => {
    if (draft[k] !== parts[k]) {
      if (live && problems[k]) return { text: `Invalid ${k === "html" ? "HTML" : "CSS"} — not applied`, title: problems[k] ?? undefined, tone: "text-amber-600 dark:text-amber-400" };
      return { text: "Editing…", tone: "text-accent" };
    }
    return applied.includes(k) ? { text: "Applied", tone: "text-emerald-600 dark:text-emerald-400" } : { text: "Synced", tone: "text-muted" };
  };

  const editor = (k: Key, height: string) => (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold" title={HINTS[k]}>
          {TITLES[k]}
        </h3>
        <StatusText {...status(k)} />
        <div className="ml-auto flex items-center gap-1">
          {k !== "baseCss" ? (
            <SmallIconButton title={`Edit ${k === "html" ? "HTML" : "CSS"} with AI`} onClick={() => setAiFor(k)}>
              <SparklesIcon className="size-3.5" />
            </SmallIconButton>
          ) : null}
          <SmallIconButton title="Open editor" onClick={() => setBigEditor(k)}>
            <CodeIcon className="size-3.5" />
          </SmallIconButton>
        </div>
      </div>
      {/* data-own-undo: ⌘Z here is the editor's own undo, not the page's. */}
      <div data-own-undo className={`${height} overflow-hidden rounded-lg border border-border`}>
        <CodeEditor
          compact
          language={k === "html" ? "html" : "css"}
          value={draft[k]}
          onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
          placeholderValues={placeholderValues}
        />
      </div>
    </section>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Source code</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2" title="Apply HTML and CSS changes to the canvas as you type.">
          <span className="text-sm font-medium">Live updates</span>
          <button
            type="button"
            role="switch"
            aria-checked={live}
            aria-label="Live updates"
            onClick={() => writeLive(!live)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${live ? "bg-accent" : "bg-foreground/20"}`}
          >
            <span className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition-transform ${live ? "translate-x-4" : ""}`} />
          </button>
        </div>

        {editor("html", "h-72")}
        {editor("pageCss", "h-44")}
        {editor("baseCss", "h-56")}

        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="secondary" onClick={exportPage} title="Download the page's HTML (what the editors show)">
              <DownloadIcon className="size-3.5" /> Export Page
            </Button>
            <Button size="sm" onClick={applyAll} disabled={!pending}>
              Apply Page
            </Button>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setImporting(true)}>
            Import External Page
          </Button>
          {notice ? <p className="text-xs text-amber-600 dark:text-amber-400">{notice}</p> : null}
        </div>
      </div>

      {bigEditor ? (
        <BigEditorDialog
          key={bigEditor}
          title={`${TITLES[bigEditor]} editor`}
          language={bigEditor === "html" ? "html" : "css"}
          initial={draft[bigEditor]}
          placeholderValues={placeholderValues}
          onSave={(v) => {
            setDraft((d) => ({ ...d, [bigEditor]: v }));
            setBigEditor(null);
          }}
          onClose={() => setBigEditor(null)}
        />
      ) : null}
      {aiFor ? <AiDialog kind={aiFor} onGenerate={(text) => runAi(aiFor, text)} onClose={() => setAiFor(null)} /> : null}
      {importing ? (
        <ImportDialog
          onImport={(url) => {
            applyWhole(importHtml(joinSource(draftRef.current), url).html);
            setImporting(false);
          }}
          onClose={() => setImporting(false)}
        />
      ) : null}
    </div>
  );
}

function StatusText({ text, title, tone }: { text: string; title?: string; tone: string }) {
  return (
    <span className={`truncate text-[11px] ${tone}`} title={title}>
      · {text}
    </span>
  );
}

function SmallIconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** A bigger editor for one source; Save puts the text back into the panel's draft. */
function BigEditorDialog({
  title,
  language,
  initial,
  placeholderValues,
  onSave,
  onClose,
}: {
  title: string;
  language: "html" | "css";
  initial: string;
  placeholderValues: Record<string, string> | null;
  onSave: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Dialog open title={title} onClose={onClose} className="sm:max-w-5xl">
      <div className="flex flex-col gap-3">
        <div data-own-undo className="h-[65vh] overflow-hidden rounded-lg border border-border">
          <CodeEditor language={language} value={value} onChange={setValue} placeholderValues={placeholderValues} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(value)}>Save</Button>
        </div>
      </div>
    </Dialog>
  );
}

function AiDialog({ kind, onGenerate, onClose }: { kind: "html" | "pageCss"; onGenerate: (instructions: string) => Promise<ActionResult>; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = kind === "html" ? "HTML" : "CSS";
  const submit = async () => {
    if (!text.trim()) return setError("Describe the change.");
    setError(null);
    setBusy(true);
    const r = await onGenerate(text.trim());
    setBusy(false);
    if (!r.ok) return setError(r.reason);
    onClose();
  };
  return (
    <Dialog
      open
      title={`Edit ${label} with AI`}
      description={kind === "html" ? "Describe the change. The current HTML is sent with it." : "Describe the change. The current Page CSS is sent with it, and the page's HTML for reference."}
      onClose={busy ? () => undefined : onClose}
      className="sm:max-w-xl"
    >
      <div className="flex flex-col gap-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={5}
          disabled={busy}
          placeholder={
            kind === "html"
              ? "E.g. make the headline shorter, add a second buy button after the testimonials, keep every id and class."
              : "E.g. make the buy buttons green with rounded corners and a bigger font on mobile."
          }
          className={TEXTAREA_CLASS}
        />
        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            <SparklesIcon className="size-4" /> {busy ? "Generating…" : "Generate"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onImport, onClose }: { onImport: (url: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return setError("Enter the full address of the page the HTML came from (https://…).");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return setError("Enter an http(s) address.");
    onImport(parsed.toString());
  };
  return (
    <Dialog
      open
      title="Import external page?"
      description="Runs the import on the HTML above: images, CSS, scripts and links with relative addresses start pointing at the page they came from. Use it for pages copied from another site."
      onClose={onClose}
      className="sm:max-w-lg"
    >
      <div className="flex flex-col gap-3">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="https://example.com/page"
          aria-label="Source page URL"
          className={INPUT_CLASS}
        />
        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit}>Import</Button>
        </div>
      </div>
    </Dialog>
  );
}
