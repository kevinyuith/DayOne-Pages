"use client";

import { useActionState, useMemo, useRef, useState, useTransition } from "react";
import { HtmlPreview } from "@/components/html-preview";
import { CodeIcon, DuplicateIcon, FilePlusIcon, LinkIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field, INPUT_CLASS, SELECT_CLASS, TEXTAREA_CLASS } from "@/components/ui/field";
import { applyPlaceholderFindings, detectPlaceholders, type PlaceholderFinding } from "@/lib/pages/detect-placeholders";
import { importHtml } from "@/lib/pages/import-html";
import { PAGE_KIND_LABELS, type PageKind } from "@/lib/pages/types";
import { createPage, fetchTemplateFromUrl, type CreatePageState } from "./actions";

const INITIAL: CreatePageState = { attempt: 0 };

/** Um template que dá para copiar. */
type TemplateChoice = { id: string; name: string; kind: PageKind; slugs_count: number };

/** Página nova de um funil do dayone-main (tela Funnel): nasce com kind FUNNEL, ligada a ele. */
export type FunnelTarget = { id: string; defaultName: string };

type Source = "template" | "link" | "html" | "blank";

const OPTIONS: { key: Source; label: string; hint: string; Icon: typeof FilePlusIcon }[] = [
  { key: "template", label: "Copy from another template", hint: "A copy of an existing template, with all its slugs.", Icon: DuplicateIcon },
  { key: "link", label: "Copy from a link", hint: "Fetches the page by its URL and brings in its HTML.", Icon: LinkIcon },
  { key: "html", label: "Copy from HTML", hint: "Paste the code of a ready-made page.", Icon: CodeIcon },
  { key: "blank", label: "Start from scratch", hint: "Starts from the blank template.", Icon: FilePlusIcon },
];

/**
 * "Criar template": primeiro a origem (outro template, link, HTML colado ou
 * do zero), depois o nome. `folderId` é a pasta onde o template nasce
 * (a aberta na tela); em sucesso a action redireciona para o editor.
 *
 * Com `funnel` (tela Funnel), é o mesmo fluxo para uma página do funil: nasce
 * com kind FUNNEL, ligada ao funil, e "do zero" já vem com Pre Lander + Lander.
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
          {OPTIONS.map(({ key, label, hint, Icon }) => {
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

  return <SourceForm key={source} source={source} folderId={folderId} templates={templates} funnel={funnel} onBack={() => setSource(null)} onCancel={onCancel} />;
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
  // Página de funil: o nome sugerido é o do funil ("F7 · GELATIN TRICK") e a origem não o troca.
  const [name, setName] = useState(funnel?.defaultName ?? "");
  const [nameTouched, setNameTouched] = useState(funnel !== null);
  const [kind, setKind] = useState<PageKind>(funnel ? "FUNNEL" : "OTHER");
  const [templateId, setTemplateId] = useState("");

  // "Copiar através de link": busca no servidor, ajusta os endereços aqui e mostra o preview.
  const [url, setUrl] = useState("");
  const [imported, setImported] = useState<{ html: string; finalUrl: string } | null>(null);
  /** O HTML que vai ser criado: o trazido pelo link, com ou sem os marcadores trocados. */
  const [linkHtml, setLinkHtml] = useState("");

  // "Copiar através de HTML": o que está na caixa e, meio segundo depois da última mudança,
  // a versão que a detecção de marcadores analisa (trocar os marcadores não dispara nova análise).
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
      {folderId ? <input type="hidden" name="folder_id" value={folderId} /> : null}
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

      {/* Sem campo de tipo: cópia herda o do template de origem; o resto nasce como "Outra". */}
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
 * Depois de trazer (link) ou colar o HTML: pergunta se troca os dados da
 * empresa que achou por marcadores. Cada achado tem caixa de marcar — a
 * detecção é por padrão de texto e pode errar. "Não" mantém o HTML como veio;
 * "Sim" troca e dá para desfazer.
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
