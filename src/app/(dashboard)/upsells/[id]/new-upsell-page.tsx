"use client";

import { useState, useTransition } from "react";
import { HtmlPreview } from "@/components/html-preview";
import { INPUT_CLASS, SELECT_CLASS, TEXTAREA_CLASS } from "@/components/ui/field";
import { importHtml } from "@/lib/pages/import-html";
import type { UpsellCopySource, UpsellPageOption } from "@/lib/pages/upsell";
import { fetchTemplateFromUrl } from "../../templates/actions";
import { createUpsellPage, type NewUpsellPageInput } from "../actions";

type Source = "page" | "template" | "link" | "html" | "blank";
const SOURCES: { key: Source; label: string }[] = [
  { key: "page", label: "Copy a page" },
  { key: "template", label: "Template" },
  { key: "link", label: "Link" },
  { key: "html", label: "HTML" },
  { key: "blank", label: "Blank" },
];

/**
 * "+ New upsell page" in a flow's Page versions: creates an upsell page of the
 * funnel's product and platform — a copy of one HTML slug of the product's
 * pages (any platform: /cp/up1, an upsell page…), a template's root, a page
 * fetched by its link, pasted HTML, or the blank page — and hands it back to
 * be put in the versions.
 */
export function NewUpsellPage({
  funnelId,
  defaultName,
  templates,
  copySources,
  onCreated,
  onCancel,
}: {
  funnelId: string;
  defaultName: string;
  templates: { id: string; name: string }[];
  copySources: UpsellCopySource[];
  onCreated: (page: UpsellPageOption) => void;
  onCancel: () => void;
}) {
  const [source, setSource] = useState<Source>(copySources.length ? "page" : "blank");
  const [name, setName] = useState(defaultName);
  const [pageSlug, setPageSlug] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [url, setUrl] = useState("");
  const [fetched, setFetched] = useState<{ html: string; finalUrl: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const fetchLink = () =>
    start(async () => {
      setError(null);
      const r = await fetchTemplateFromUrl(url);
      if (!r.ok) {
        setFetched(null);
        return setError(r.reason);
      }
      const page = importHtml(r.html, r.finalUrl);
      setFetched({ html: page.html, finalUrl: r.finalUrl });
    });

  const input = (): NewUpsellPageInput | null => {
    if (source === "page") {
      const [pageId, slug] = pageSlug.split("|");
      return pageId && slug ? { source, name, pageId, slug } : null;
    }
    if (source === "template") return templateId ? { source, name, templateId } : null;
    if (source === "link") return fetched ? { source: "html", name, content: fetched.html, sourceUrl: fetched.finalUrl } : null;
    if (source === "html") return pasted.trim() ? { source, name, content: pasted } : null;
    return { source: "blank", name };
  };
  const ready = input() !== null && name.trim().length >= 2;

  const create = () =>
    start(async () => {
      const i = input();
      if (!i) return;
      setError(null);
      const r = await createUpsellPage(funnelId, i);
      if (!r.ok) return setError(r.reason);
      onCreated(r.page);
    });

  return (
    <div className="flex flex-col gap-3 border-b border-border/60 bg-accent/5 px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <b className="text-sm">New upsell page</b>
        <div role="group" aria-label="Source" className="inline-flex h-9 items-center rounded-lg border border-border bg-surface p-0.5">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={source === s.key}
              disabled={pending || (s.key === "page" && copySources.length === 0) || (s.key === "template" && templates.length === 0)}
              onClick={() => {
                setSource(s.key);
                setError(null);
              }}
              className={`h-full rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-40 ${source === s.key ? "bg-foreground/[0.08] text-foreground" : "text-muted hover:text-foreground"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {source === "page" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Page and slug</span>
          <select value={pageSlug} onChange={(e) => setPageSlug(e.target.value)} disabled={pending} className={`${SELECT_CLASS} max-w-xl`}>
            <option value="">— choose —</option>
            {copySources.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.slugs.map((slug) => (
                  <option key={slug} value={`${p.id}|${slug}`}>
                    {slug}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      ) : null}

      {source === "template" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Template</span>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={pending} className={`${SELECT_CLASS} max-w-xl`}>
            <option value="">— choose —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {source === "link" ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted">Page URL</span>
            <span className="flex max-w-xl gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    fetchLink();
                  }
                }}
                placeholder="https://example.com/up1"
                disabled={pending}
                className={INPUT_CLASS}
              />
              <button type="button" onClick={fetchLink} disabled={pending || !url.trim()} className="min-h-10 shrink-0 rounded-lg border border-border px-3 text-sm font-semibold disabled:opacity-40">
                Fetch
              </button>
            </span>
          </label>
          {fetched ? <HtmlPreview html={fetched.html} className="h-48 w-full max-w-xl bg-white" /> : null}
        </div>
      ) : null}

      {source === "html" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Page HTML</span>
          <textarea
            rows={8}
            spellCheck={false}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={"<!doctype html>\n<html>…</html>"}
            disabled={pending}
            className={`${TEXTAREA_CLASS} max-w-xl font-mono text-xs`}
          />
        </label>
      ) : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} disabled={pending} className={`${INPUT_CLASS} max-w-xl`} />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button type="button" onClick={create} disabled={pending || !ready} className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-40">
          {pending ? "Creating…" : "Create and add"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className="min-h-10 px-2 text-sm font-semibold text-muted hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}
