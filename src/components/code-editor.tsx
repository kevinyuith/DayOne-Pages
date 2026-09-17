"use client";

import { html } from "@codemirror/lang-html";
import dynamic from "next/dynamic";
import { useMemo, useSyncExternalStore } from "react";

/**
 * CodeMirror 6 só no cliente: o componente toca o DOM ao montar, e o
 * carregamento dinâmico sem SSR evita o pacote no HTML inicial.
 */
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-foreground/5" />,
});

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeDark(callback: () => void) {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function usePrefersDark(): boolean {
  return useSyncExternalStore(
    subscribeDark,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
}

export function CodeEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const dark = usePrefersDark();
  const extensions = useMemo(() => [html({ autoCloseTags: true, matchClosingTags: true })], []);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={dark ? "dark" : "light"}
      height="100%"
      className="h-full text-[13px] [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: true }}
    />
  );
}
