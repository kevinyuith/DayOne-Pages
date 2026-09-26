"use client";

import { useActionState, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HtmlPreview } from "@/components/html-preview";
import { CodeIcon, DuplicateIcon, ExternalIcon, FilePlusIcon, LinkIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS, SELECT_CLASS, TEXTAREA_CLASS } from "@/components/ui/field";
import { applyPlaceholderFindings, detectPlaceholders, type PlaceholderFinding } from "@/lib/pages/detect-placeholders";
import { importHtml } from "@/lib/pages/import-html";
import { PAGE_KIND_LABELS, type PageKind } from "@/lib/pages/types";
import { createPage, fetchTemplateFromUrl, type CreatePageState } from "./actions";
import { createFunnelRedirect } from "../funnels/actions";

const INITIAL: CreatePageState = { attempt: 0 };

/** A template that can be copied. */
type TemplateChoice = { id: string; name: string; kind: PageKind; slugs_count: number };

/** New page for a dayone-main funnel (Funnel screen): created with kind FUNNEL, linked to it. */
export type FunnelTarget = { id: string; defaultName: string };

type Source = "template" | "link" | "html" | "blank" | "redirect";

const OPTIONS: { key: Source; label: string; hint: string; Icon: typeof FilePlusIcon }[] = [
  { key: "template", label: "Copy from another template", hint: "A copy of an existing template, with all its slugs.", Icon: DuplicateIcon },
  { key: "link", label: "Copy from a link", hint: "Fetches the page by its URL and brings in its HTML.", Icon: LinkIcon },
  { key: "html", label: "Copy from HTML", hint: "Paste the code of a ready-made page.", Icon: CodeIcon },
  { key: "blank", label: "Start from scratch", hint: "Starts from the blank template.", Icon: FilePlusIcon },
];

/** Only on the Funnel screen: a funnel entry that 302s to a URL instead of serving a page. */
const REDIRECT_OPTION = { key: "redirect" as const, label: "Redirect", hint: "302s the visitor to a URL. Use {sub1} to drop visit parameters in.", Icon: ExternalIcon };

/**
 * "Create template": first the source (another template, link, pasted HTML or
 * from scratch), then the name. `folderId` is the folder (its path) the template
 * is created in (the one open on screen); on success the action redirects to the editor.
 *
 * With `funnel` (Funnel screen), it's the same flow for a funnel page: created
 * with kind FUNNEL, linked to the funnel, and "from scratch" comes with Pre Lander + Lander.
 */
export function CreatePageForm({
  folderId = null,
  templates,
  funnel = null,
  onCancel,
}: {
  folderId?: string | null;
  templates: TemplateChoice[];
  funnel?: FunnelTarget | null;
  onCancel?: () => void;
}) {
  const [source, setSource] = useState<Source | null>(null);

  if (!source) {
    return (
      <div className="flex flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {(funnel ? [...OPTIONS, REDIRECT_OPTION] : OPTIONS).map(({ key, label, hint, Icon }) => {
            const disabled = key === "template" && templates.length === 0;
            return (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => setSource(key)}
                className="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:border-accent hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon className="mt-0.5 size-5 shrink-0 text-accent" />
                <span>
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {disabled ? "No templates yet." : funnel && key === "blank" ? "Starts with a Pre Lander and a Lander." : hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {onCancel ? (
          <div>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (source === "redirect" && funnel) {
    return <RedirectSource funnel={funnel} onBack={() => setSource(null)} onCancel={onCancel} />;
  }

  return <SourceForm key={source} source={source} folderId={folderId} templates={templates} funnel={funnel} onBack={() => setSource(null)} onCancel={onCancel} />;
}

/** Create a redirect entry of the funnel: a name and the destination URL template. */
function RedirectSource({ funnel, onBack, onCancel }: { funnel: FunnelTarget; onBack: () => void; onCancel?: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(funnel.defaultName);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const r = await createFunnelRedirect(funnel.id, name, url);
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      router.refresh();
      onCancel?.();
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center gap-2 text-sm">
        <button type="button" onClick={onBack} disabled={pending} className="text-muted hover:text-foreground">
          ← Options
        </button>
        <span className="text-muted">·</span>
        <span className="font-medium">Redirect</span>
      </div>
      <Field label="Destination URL">
        <input value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} placeholder="https://offer.com/?utm_campaign={sub1}" disabled={pending} className={`${INPUT_CLASS} font-mono text-xs`} />
      </Field>
      <p className="-mt-1 text-xs text-muted">
        Use {"{name}"} to drop a visit parameter into the URL, e.g. {"{sub1}"} or {"{fbclid}"}. Only what the URL names is carried; anything else is left out.
      </p>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} disabled={pending} className={INPUT_CLASS} />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="mt-1 flex gap-2">
        <Button type="submit" disabled={pending || !url.trim()}>
          {pending ? "Creating…" : "Create redirect"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function SourceForm({
  source,
  folderId,
  templates,
  funnel,
  onBack,
  onCancel,
}: {
  source: Source;
  folderId: string | null;
  templates: TemplateChoice[];
  funnel: FunnelTarget | null;
  onBack: () => void;
  onCancel?: () => void;
}) {
  const [state, action, pending] = useActionState(createPage, INITIAL);
  // Funnel page: the suggested name is the funnel's ("F7 · GELATIN TRICK") and the source doesn't change it.
  const [name, setName] = useState(funnel?.defaultName ?? "");
  const [nameTouched, setNameTouched] = useState(funnel !== null);
  const [kind, setKind] = useState<PageKind>(funnel ? "FUNNEL" : "OTHER");
  const [templateId, setTemplateId] = useState("");

  // "Copy from a link": fetches on the server, adjusts the addresses here and shows the preview.
  const [url, setUrl] = useState("");
  const [imported, setImported] = useState<{ html: string; finalUrl: string } | null>(null);
  /** The HTML that will be created: the one fetched from the link, with or without the placeholders swapped. */
  const [linkHtml, setLinkHtml] = useState("");

  // "Copy from HTML": what's in the box and, half a second after the last change,
  // the version the placeholder detection analyzes (swapping placeholders doesn't trigger a new analysis).
  const [pasted, setPasted] = useState("");
  const [pastedBase, setPastedBase] = useState("");
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPaste = (value: string) => {
    setPasted(value);
    if (pasteTimer.current) clearTimeout(pasteTimer.current);
    pasteTimer.current = setTimeout(() => setPastedBase(value), 500);
  };
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, startFetch] = useTransition();

  const suggestName = (value: string) => {
    if (!nameTouched) setName(value.slice(0, 120));
  };

  const onPickTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((p) => p.id === id);
    if (t) {
      suggestName(`${t.name} (copy)`);
      if (!funnel) setKind(t.kind);
    }
  };

  const onFetch = () => {
    if (!url.trim()) return;
    setFetchError(null);
    startFetch(async () => {
      const r = await fetchTemplateFromUrl(url);
      if (!r.ok) {
        setImported(null);
        setFetchError(r.reason);
        return;
      }
      const page = importHtml(r.html, r.finalUrl);
      setImported({ html: page.html, finalUrl: r.finalUrl });
      setLinkHtml(page.html);
      if (page.title) suggestName(page.title);
    });
  };

  const option = OPTIONS.find((o) => o.key === source)!;
  const blocked = pending || (source === "link" && !imported) || (source === "template" && !templateId);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="source" value={source === "link" ? "html" : source} />
      {folderId ? <input type="hidden" name="folder" value={folderId} /> : null}
      {funnel ? <input type="hidden" name="funnel_id" value={funnel.id} /> : null}

      <div className="flex items-center gap-2 text-sm">
        <button type="button" onClick={onBack} disabled={pending} className="text-muted hover:text-foreground">
          ← Options
        </button>
        <span className="text-muted">·</span>
        <span className="font-medium">{option.label}</span>
      </div>

      {source === "template" ? (
        <Field label="Source template">
          <select name="template_id" value={templateId} onChange={(e) => onPickTemplate(e.target.value)} disabled={pending} className={SELECT_CLASS}>
            <option value="">— choose —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {PAGE_KIND_LABELS[t.kind]} · {t.slugs_count} {t.slugs_count === 1 ? "slug" : "slugs"}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {source === "link" ? (
        <div className="flex flex-col gap-2">
          <Field label="Page URL">
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onFetch();
                  }
                }}
                placeholder="https://example.com/page"
                disabled={pending || fetching}
                className={INPUT_CLASS}
              />
              <Button type="button" variant="secondary" onClick={onFetch} disabled={pending || fetching || !url.trim()}>
                {fetching ? "Fetching…" : "Fetch"}
              </Button>
            </div>
          </Field>
          {fetchError ? <p className="text-xs text-red-600 dark:text-red-400">{fetchError}</p> : null}
          {imported ? <PlaceholderSuggestions key={imported.html} html={imported.html} sourceUrl={imported.finalUrl} onApply={setLinkHtml} /> : null}
          {imported ? (
            <>
              <input type="hidden" name="content" value={linkHtml} />
              <input type="hidden" name="source_url" value={imported.finalUrl} />
              <HtmlPreview html={linkHtml} className="h-56 w-full bg-white" />
              <p className="text-xs text-muted">
                Fetched from {imported.finalUrl} ({Math.max(1, Math.round(new Blob([imported.html]).size / 1024))} KB). Images, CSS and links now use absolute
                URLs; the links still point to the source site — change them in the editor&apos;s Links panel.
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      {source === "html" ? (
        <div className="flex flex-col gap-2">
          <Field label="Page HTML">
            <textarea
              name="content"
              required
              rows={10}
              spellCheck={false}
              value={pasted}
              onChange={(e) => onPaste(e.target.value)}
              placeholder={"<!doctype html>\n<html>…</html>"}
              disabled={pending}
              className={`${TEXTAREA_CLASS} font-mono text-xs`}
            />
          </Field>
          {pastedBase.trim() ? <PlaceholderSuggestions key={pastedBase} html={pastedBase} onApply={setPasted} /> : null}
        </div>
      ) : null}

      {/* No type field: a copy inherits the source template's; everything else starts as "Other". */}
      <input type="hidden" name="kind" value={kind} />
      <Field label={funnel ? "Page name" : "Template name"}>
        <input
          name="name"
          required
          minLength={2}
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
          placeholder="E.g. Main offer"
          disabled={pending}
          className={INPUT_CLASS}
        />
      </Field>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      <div className="mt-1 flex gap-2">
        <Button type="submit" disabled={blocked}>
          {pending ? "Creating…" : funnel ? "Create page" : "Create template"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * After fetching (link) or pasting the HTML: asks whether to replace the company
 * details it found with placeholders. Each finding has a checkbox — detection
 * is by text pattern and can be wrong. "No" keeps the HTML as it came;
 * "Yes" replaces them and can be undone.
 */
function PlaceholderSuggestions({ html, sourceUrl, onApply }: { html: string; sourceUrl?: string; onApply: (next: string) => void }) {
  const findings = useMemo(() => detectPlaceholders(html, sourceUrl), [html, sourceUrl]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [answer, setAnswer] = useState<{ kind: "yes"; replaced: number } | { kind: "no" } | null>(null);

  if (findings.length === 0) return null;

  const chosen = findings.filter((f) => !unchecked.has(f.id));
  const toggle = (f: PlaceholderFinding) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(f.id)) next.delete(f.id);
      else next.add(f.id);
      return next;
    });

  if (answer?.kind === "yes") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
        {answer.replaced} {answer.replaced === 1 ? "snippet replaced" : "snippets replaced"} with placeholders. Each domain shows its own details.
        <button
          type="button"
          className="text-muted underline hover:text-foreground"
          onClick={() => {
            onApply(html);
            setAnswer(null);
          }}
        >
          Undo
        </button>
      </p>
    );
  }
  if (answer?.kind === "no") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        Kept the original text.
        <button type="button" className="underline hover:text-foreground" onClick={() => setAnswer(null)}>
          Review
        </button>
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
      <p className="font-medium">Replace the company details with placeholders?</p>
      <p className="mt-0.5 text-xs text-muted">We found these texts. Uncheck anything that isn&apos;t company details.</p>
      <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-auto">
        {findings.map((f) => (
          <li key={f.id}>
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input type="checkbox" checked={!unchecked.has(f.id)} onChange={() => toggle(f)} className="mt-0.5 size-3.5 accent-accent" />
              <span className="min-w-0">
                <span className="break-words">&ldquo;{f.text.length > 70 ? `${f.text.slice(0, 70)}…` : f.text}&rdquo;</span>
                <span className="text-muted"> → </span>
                <code className="font-mono text-accent">{f.replacement}</code>
                <span className="text-muted"> · {f.count}×</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={chosen.length === 0}
          onClick={() => {
            onApply(applyPlaceholderFindings(html, chosen));
            setAnswer({ kind: "yes", replaced: chosen.reduce((n, f) => n + f.count, 0) });
          }}
        >
          Yes, replace
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAnswer({ kind: "no" })}>
          No, keep
        </Button>
      </div>
    </div>
  );
}
