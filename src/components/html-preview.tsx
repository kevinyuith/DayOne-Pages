"use client";

import { useEffect, useState } from "react";
import { injectBase } from "@/lib/pages/starter-template";

/**
 * HTML preview in an isolated iframe.
 *
 * `sandbox` without `allow-same-origin`: the document runs in an opaque origin and
 * cannot reach the dashboard's cookies or storage, even with scripts enabled. Never
 * combine `allow-scripts` with `allow-same-origin` — that is the combination that lets
 * the content escape the sandbox.
 *
 * Debounce: CodeMirror fires on every keystroke; re-rendering the iframe on every
 * keystroke makes typing lag on large pages.
 */
const DEBOUNCE_MS = 400;

export function HtmlPreview({ html, baseHref, className = "" }: { html: string; baseHref?: string; className?: string }) {
  const [doc, setDoc] = useState(() => (baseHref ? injectBase(html, baseHref) : html));

  useEffect(() => {
    const t = setTimeout(() => setDoc(baseHref ? injectBase(html, baseHref) : html), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [html, baseHref]);

  return (
    <iframe
      title="Page preview"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      srcDoc={doc}
      className={`block rounded-lg border border-border ${className}`}
    />
  );
}
