"use client";

import { pickedCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { html } from "@codemirror/lang-html";
import { EditorState } from "@codemirror/state";
import dynamic from "next/dynamic";
import { useMemo, useSyncExternalStore } from "react";
import { openPlaceholderAt, placeholderToken, suggestPlaceholders } from "@/lib/pages/placeholders";

/**
 * CodeMirror 6 on the client only: the component touches the DOM on mount, and
 * dynamic loading without SSR keeps the package out of the initial HTML.
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

/**
 * Placeholder autocomplete: typing "{{" (in text, an attribute, script or
 * style) opens the list. The "}}" that bracket auto-closing puts after the
 * cursor is absorbed when an option is picked.
 */
function placeholderCompletions(values: Record<string, string> | null) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const at = openPlaceholderAt(line.text.slice(0, ctx.pos - line.from));
    const items = at ? suggestPlaceholders(at.query) : [];
    if (!at || !items.length) return null;
    return {
      from: line.from + at.from,
      filter: false,
      options: items.map((o) => {
        const token = placeholderToken(o.key);
        return {
          label: token,
          detail: values ? values[o.key] || "(empty)" : o.label,
          type: "variable",
          apply: (view, completion, from, to) => {
            const after = view.state.sliceDoc(to, to + 2);
            const extra = after.startsWith("}}") ? 2 : after.startsWith("}") ? 1 : 0;
            view.dispatch({
              changes: { from, to: to + extra, insert: token },
              selection: { anchor: from + token.length },
              annotations: pickedCompletion.of(completion),
              userEvent: "input.complete",
            });
          },
        };
      }),
    };
  };
}

export function CodeEditor({
  value,
  onChange,
  placeholderValues = null,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Placeholder values (domain page), shown in the "{{" list. Template: null. */
  placeholderValues?: Record<string, string> | null;
}) {
  const dark = usePrefersDark();
  const extensions = useMemo(() => {
    // The SAME function on every call: CodeMirror recognizes the source by reference.
    const placeholders = [{ autocomplete: placeholderCompletions(placeholderValues) }];
    return [html({ autoCloseTags: true, matchClosingTags: true }), EditorState.languageData.of(() => placeholders)];
  }, [placeholderValues]);

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
