"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { CodeEditor } from "@/components/code-editor";
import { HtmlPreview } from "@/components/html-preview";
import { Alert } from "@/components/ui/alert";
import { Badge, PAGE_STATUS_TONE } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INPUT_BASE, INPUT_CLASS, SELECT_BASE } from "@/components/ui/field";
import { isFullDocument, wrapFragment } from "@/lib/pages/starter-template";
import {
  PAGE_KINDS,
  PAGE_KIND_LABELS,
  PAGE_STATUS_LABELS,
  type Page,
  type PageKind,
  type PageSlug,
  type PageSlugSummary,
  type PageStatus,
} from "@/lib/pages/types";
import { createSlug, deletePage, deleteSlug, renameSlug, saveEditor, toggleSlug } from "../../../actions";

/**
 * O editor: cabeçalho da página, barra de slugs, código e preview.
 *
 * O estado local é a verdade enquanto a pessoa edita; o servidor só é
 * consultado ao salvar. `saveEditor` devolve os `updated_at` novos e o
 * editor os guarda para o próximo salvamento (concorrência otimista). Em
 * `conflict`, a tela avisa e oferece recarregar — o que descarta o que está
 * na tela, e a mensagem diz isso.
 */

type Device = "desktop" | "mobile";

export function PageEditor({
  page,
  slugs,
  slug,
  domains,
}: {
  page: Page;
  slugs: PageSlugSummary[];
  slug: PageSlug;
  domains: string[];
}) {
  const router = useRouter();

  const [name, setName] = useState(page.name);
  const [kind, setKind] = useState<PageKind>(page.kind);
  const [status, setStatus] = useState<PageStatus>(page.status);
  const [content, setContent] = useState(slug.content);
  const [pageUpdatedAt, setPageUpdatedAt] = useState(page.updated_at);
  const [slugUpdatedAt, setSlugUpdatedAt] = useState(slug.updated_at);
  const [savedSnapshot, setSavedSnapshot] = useState({ name: page.name, kind: page.kind, status: page.status, content: slug.content });
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [previewBase, setPreviewBase] = useState<string>(domains[0] ?? "");
  const [pending, startTransition] = useTransition();
  const [busy, startBusy] = useTransition();

  const dirtyMeta = name !== savedSnapshot.name || kind !== savedSnapshot.kind || status !== savedSnapshot.status;
  const dirtyContent = content !== savedSnapshot.content;
  const dirty = dirtyMeta || dirtyContent;

  const save = useCallback(() => {
    if (pending) return;
    startTransition(async () => {
      const result = await saveEditor({
        page: { id: page.id, name, kind, status, expectedUpdatedAt: pageUpdatedAt },
        slug: dirtyContent ? { id: slug.id, content, expectedUpdatedAt: slugUpdatedAt } : null,
      });
      if (!result.ok) {
        setMessage(
          result.reason === "conflict"
            ? { tone: "warning", text: "Esta página foi salva em outro lugar desde que você a abriu. Recarregue para ver a versão atual (o que está nesta tela será descartado)." }
            : { tone: "danger", text: result.reason },
        );
        return;
      }
      setPageUpdatedAt(result.pageUpdatedAt);
      if (result.slugUpdatedAt) setSlugUpdatedAt(result.slugUpdatedAt);
      setSavedSnapshot({ name, kind, status, content });
      setLastSavedAt(new Date());
      setMessage(null);
      // A lista de páginas e a barra de slugs leem do servidor; o próprio
      // editor não precisa de nada de volta.
      router.refresh();
    });
  }, [pending, page.id, name, kind, status, pageUpdatedAt, dirtyContent, slug.id, content, slugUpdatedAt, router]);

  // Cmd/Ctrl+S salva. Captura para chegar antes do CodeMirror e do navegador.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save]);

  // Guarda de saída: fechar a aba ou clicar num link com alterações pendentes.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      if (!window.confirm("Há alterações não salvas. Sair mesmo assim?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  function run(task: () => Promise<{ ok: boolean; reason?: string }>, after?: () => void) {
    startBusy(async () => {
      const r = await task();
      if (!r.ok) {
        setMessage({ tone: "danger", text: r.reason ?? "Erro." });
        return;
      }
      setMessage(null);
      after?.();
      router.refresh();
    });
  }

  function onNewSlug(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const value = String(new FormData(form).get("slug") ?? "");
    if (!value.trim()) return;
    startBusy(async () => {
      const r = await createSlug(page.id, value, null);
      if (!r.ok) {
        setMessage({ tone: "danger", text: r.reason });
        return;
      }
      form.reset();
      setMessage(null);
      router.push(`/paginas/${page.id}/slugs/${r.slugId}`);
    });
  }

  function onRenameSlug() {
    const value = window.prompt("Novo path da slug:", slug.slug);
    if (value === null || value.trim() === slug.slug) return;
    run(() => renameSlug(slug.id, value));
  }

  function onDeleteSlug() {
    if (!window.confirm(`Remover a slug ${slug.slug}? O HTML dela será perdido.`)) return;
    startBusy(async () => {
      const r = await deleteSlug(slug.id);
      if (!r.ok) {
        setMessage({ tone: "danger", text: r.reason });
        return;
      }
      const next = slugs.find((s) => s.id !== slug.id);
      router.push(next ? `/paginas/${page.id}/slugs/${next.id}` : "/paginas");
    });
  }

  function onDeletePage() {
    if (!window.confirm(`Excluir a página "${page.name}" e todas as slugs? Domínios que a usam como padrão ficarão sem página.`)) return;
    startBusy(async () => {
      const r = await deletePage(page.id);
      if (!r.ok) {
        setMessage({ tone: "danger", text: r.reason });
        return;
      }
      dirtyRef.current = false;
      router.push("/paginas");
    });
  }

  const fragment = !isFullDocument(content);

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col gap-3">
      {/* Cabeçalho */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/paginas" className="text-sm text-muted hover:text-foreground">
          ← Páginas
        </Link>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Nome da página"
          className={`${INPUT_BASE} h-9 w-56 font-medium`}
        />
        <select value={kind} onChange={(e) => setKind(e.target.value as PageKind)} aria-label="Tipo" className={`${SELECT_BASE} h-9 w-40`}>
          {PAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {PAGE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as PageStatus)}
          aria-label="Status"
          className={`${SELECT_BASE} h-9 w-36`}
        >
          <option value="DRAFT">{PAGE_STATUS_LABELS.DRAFT}</option>
          <option value="PUBLISHED">{PAGE_STATUS_LABELS.PUBLISHED}</option>
          <option value="ARCHIVED">{PAGE_STATUS_LABELS.ARCHIVED}</option>
        </select>
        <Badge tone={PAGE_STATUS_TONE[savedSnapshot.status]}>{PAGE_STATUS_LABELS[savedSnapshot.status]}</Badge>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted">
            {pending ? "Salvando…" : dirty ? "Alterações não salvas" : lastSavedAt ? `Salvo às ${lastSavedAt.toLocaleTimeString("pt-BR")}` : "Tudo salvo"}
          </span>
          <Button size="sm" onClick={save} disabled={pending || !dirty}>
            Salvar <kbd className="ml-1 rounded bg-black/10 px-1 text-[10px]">⌘S</kbd>
          </Button>
          <Button size="sm" variant="danger" onClick={onDeletePage} disabled={busy}>
            Excluir página
          </Button>
        </div>
      </div>

      {message ? (
        <Alert tone={message.tone}>
          <span>{message.text}</span>
          {message.tone === "warning" ? (
            <button type="button" className="ml-2 underline" onClick={() => window.location.reload()}>
              Recarregar
            </button>
          ) : null}
        </Alert>
      ) : null}

      {savedSnapshot.status !== "PUBLISHED" ? (
        <Alert tone="warning">Só páginas com status Publicada são servidas nos domínios. Esta está como {PAGE_STATUS_LABELS[savedSnapshot.status].toLowerCase()}.</Alert>
      ) : null}

      {/* Corpo */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)]">
        {/* Slugs */}
        <aside className="flex min-h-0 flex-col rounded-xl border border-border bg-surface">
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted">Slugs</div>
          <ul className="min-h-0 flex-1 overflow-auto p-2">
            {slugs.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/paginas/${page.id}/slugs/${s.id}`}
                  aria-current={s.id === slug.id ? "page" : undefined}
                  className={[
                    "block truncate rounded-lg px-2 py-1.5 font-mono text-xs",
                    s.id === slug.id ? "bg-accent/10 text-accent" : "text-foreground hover:bg-foreground/5",
                    s.is_active ? "" : "line-through opacity-60",
                  ].join(" ")}
                  title={s.is_active ? s.slug : `${s.slug} (inativa)`}
                >
                  {s.slug}
                </Link>
              </li>
            ))}
          </ul>
          <form onSubmit={onNewSlug} className="flex gap-1 border-t border-border p-2">
            <input name="slug" placeholder="/nova" disabled={busy} className={`${INPUT_CLASS} h-8 font-mono text-xs`} />
            <Button type="submit" size="sm" variant="secondary" disabled={busy}>
              +
            </Button>
          </form>
          <div className="flex flex-wrap gap-1 border-t border-border p-2">
            <Button size="sm" variant="ghost" onClick={onRenameSlug} disabled={busy}>
              Renomear
            </Button>
            <Button size="sm" variant="ghost" onClick={() => run(() => toggleSlug(slug.id, !slug.is_active))} disabled={busy}>
              {slug.is_active ? "Desativar" : "Ativar"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDeleteSlug} disabled={busy}>
              Remover
            </Button>
          </div>
        </aside>

        {/* Código */}
        <section className="flex min-h-[24rem] flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
            <span className="font-mono">{slug.slug}</span>
            <span>· HTML</span>
            {fragment ? (
              <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setContent(wrapFragment(content, { title: name }))}>
                Envolver fragmento em documento
              </Button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1">
            <CodeEditor value={content} onChange={setContent} />
          </div>
        </section>

        {/* Preview */}
        <section className="flex min-h-[24rem] flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
            <span>Preview</span>
            <select
              value={previewBase}
              onChange={(e) => setPreviewBase(e.target.value)}
              aria-label="Domínio base do preview"
              className={`${SELECT_BASE} h-7 w-44 text-xs`}
            >
              <option value="">Sem domínio base</option>
              {domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant={device === "desktop" ? "primary" : "ghost"} onClick={() => setDevice("desktop")}>
                Desktop
              </Button>
              <Button size="sm" variant={device === "mobile" ? "primary" : "ghost"} onClick={() => setDevice("mobile")}>
                Celular
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-foreground/5 p-2">
            <HtmlPreview
              html={content}
              baseHref={previewBase ? `https://${previewBase}/` : undefined}
              className={device === "mobile" ? "mx-auto h-full w-[375px] bg-white" : "h-full w-full bg-white"}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
