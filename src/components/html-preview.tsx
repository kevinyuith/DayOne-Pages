"use client";

import { useEffect, useState } from "react";
import { injectBase } from "@/lib/pages/starter-template";

/**
 * Preview do HTML num iframe isolado.
 *
 * `sandbox` sem `allow-same-origin`: o documento roda numa origem opaca e não
 * alcança cookies nem storage do dashboard, mesmo com scripts ligados. Nunca
 * junte `allow-scripts` com `allow-same-origin` — é a combinação que deixa o
 * conteúdo escapar do sandbox.
 *
 * Debounce: o CodeMirror dispara a cada tecla; re-renderizar o iframe a cada
 * tecla trava a digitação em páginas grandes.
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
      title="Preview da página"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      srcDoc={doc}
      className={`block rounded-lg border border-border ${className}`}
    />
  );
}
