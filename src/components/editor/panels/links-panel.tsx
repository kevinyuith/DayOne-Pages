"use client";

import { useMemo, useState } from "react";
import { ChevronRightIcon, ExternalIcon, LinkIcon, SearchIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { INPUT_BASE } from "@/components/ui/field";
import { groupByDestination, type LinkEntry, type LinkKind } from "@/lib/pages/links";

/**
 * Painel "Links": todos os links que a página tem, agrupados por destino —
 * como o hidepages mostra os links atrelados a uma página.
 *
 *  - clicar num link seleciona o elemento na canvas (e rola até ele);
 *  - "Trocar" num destino troca TODAS as ocorrências dele de uma vez;
 *  - "Apontar todos" manda todos os links da página para um destino só.
 *
 * O painel não toca no HTML: quem aplica é o editor, via `onReplace`/
 * `onReplaceAll` (na canvas ao vivo ou no HTML em modo código).
 */
export function LinksPanel({
  links,
  selectedUid,
  canEdit,
  onSelect,
  onReplace,
  onReplaceAll,
}: {
  links: LinkEntry[];
  selectedUid: string | null;
  /** Falso para fragmentos (a edição precisa de documento completo). */
  canEdit: boolean;
  onSelect: (uid: string) => void;
  onReplace: (from: string, to: string) => void;
  onReplaceAll: (to: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [allTo, setAllTo] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) => l.href.toLowerCase().includes(q) || l.label.toLowerCase().includes(q));
  }, [links, query]);
  const groups = useMemo(() => groupByDestination(filtered), [filtered]);

  const attached = links.filter((l) => l.kind === "attached").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Links</div>
        <p className="mt-0.5 text-[11px] text-muted">
          {links.length === 0
            ? "Nenhum link nesta página."
            : `${links.length} ${links.length === 1 ? "link" : "links"} · ${groups.length} ${groups.length === 1 ? "destino" : "destinos"}${
                attached ? ` · ${attached} atrelado${attached > 1 ? "s" : ""}` : ""
              }`}
        </p>
      </div>

      {links.length > 3 ? (
        <label className="relative m-2">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrar por URL ou texto…"
            className={`${INPUT_BASE} h-8 w-full pl-8 text-xs`}
          />
        </label>
      ) : null}

      <ul className="min-h-0 flex-1 overflow-auto p-2">
        {groups.length === 0 && links.length > 0 ? <li className="px-2 py-4 text-center text-xs text-muted">Nada bate com o filtro.</li> : null}
        {links.length === 0 ? (
          <li className="px-2 py-4 text-center text-xs text-muted">
            Selecione um botão, imagem ou bloco na canvas e cole um destino no campo <b>Link</b> do inspetor para atrelar um link a ele.
          </li>
        ) : null}
        {groups.map((g) => (
          <DestinationGroup
            key={g.href || "(vazio)"}
            href={g.href}
            entries={g.entries}
            selectedUid={selectedUid}
            canEdit={canEdit}
            onSelect={onSelect}
            onReplace={(to) => onReplace(g.href, to)}
          />
        ))}
      </ul>

      {links.length > 1 && canEdit ? (
        <form
          className="flex flex-col gap-1.5 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            const to = allTo.trim();
            if (!to) return;
            if (!window.confirm(`Apontar todos os ${links.length} links desta página para\n${to}?`)) return;
            onReplaceAll(to);
            setAllTo("");
          }}
        >
          <span className="text-[11px] font-medium text-muted">Apontar todos os links para</span>
          <div className="flex gap-1">
            <input value={allTo} onChange={(e) => setAllTo(e.target.value)} placeholder="https://…" className={`${INPUT_BASE} h-8 w-full font-mono text-xs`} />
            <Button type="submit" size="sm" variant="secondary" disabled={!allTo.trim()}>
              Aplicar
            </Button>
          </div>
        </form>
      ) : null}
      {!canEdit && links.length > 0 ? (
        <p className="border-t border-border p-2 text-[11px] text-muted">Para trocar links, envolva o fragmento num documento (modo Visual).</p>
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<LinkKind, string> = { anchor: "a", form: "form", attached: "atrelado" };

function DestinationGroup({
  href,
  entries,
  selectedUid,
  canEdit,
  onSelect,
  onReplace,
}: {
  href: string;
  entries: LinkEntry[];
  selectedUid: string | null;
  canEdit: boolean;
  onSelect: (uid: string) => void;
  onReplace: (to: string) => void;
}) {
  const hasSelected = entries.some((e) => e.uid === selectedUid);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(href);
  const external = entries[0]?.external;

  const submit = () => {
    const v = to.trim();
    setEditing(false);
    if (v && v !== href) onReplace(v);
    else setTo(href);
  };

  return (
    <li className={`mb-1 rounded-lg border ${hasSelected ? "border-accent/50" : "border-border"}`}>
      <div className="flex items-start gap-1 px-2 py-1.5">
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 shrink-0 text-muted hover:text-foreground" title={open ? "Recolher" : "Expandir"}>
          <ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={to}
              onChange={(e) => setTo(e.target.value)}
              onBlur={submit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setTo(href);
                  setEditing(false);
                }
              }}
              className={`${INPUT_BASE} h-7 w-full font-mono text-[11px]`}
            />
          ) : (
            <button
              type="button"
              onClick={() => onSelect(entries[0].uid)}
              className="flex w-full items-center gap-1 text-left font-mono text-[11px] text-foreground hover:text-accent"
              title={href || "(sem destino)"}
            >
              {external ? <ExternalIcon className="size-3 shrink-0 text-muted" /> : <LinkIcon className="size-3 shrink-0 text-muted" />}
              <span className="truncate">{href || <em className="text-muted">(sem destino)</em>}</span>
            </button>
          )}
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
            <span>
              {entries.length} {entries.length === 1 ? "ocorrência" : "ocorrências"}
            </span>
            {canEdit && !editing ? (
              <button type="button" onClick={() => setEditing(true)} className="text-accent hover:underline">
                Trocar
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {open ? (
        <ul className="border-t border-border">
          {entries.map((e) => (
            <li key={e.uid}>
              <button
                type="button"
                onClick={() => onSelect(e.uid)}
                aria-current={e.uid === selectedUid ? "true" : undefined}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-foreground/5 ${
                  e.uid === selectedUid ? "bg-accent/10 text-accent" : "text-foreground"
                }`}
              >
                <code className="shrink-0 rounded bg-foreground/5 px-1 text-[10px] text-muted">{KIND_LABEL[e.kind] === "a" ? `<${e.tag}>` : KIND_LABEL[e.kind]}</code>
                <span className="truncate">{e.label}</span>
                {e.page ? <span className="ml-auto shrink-0 rounded bg-foreground/5 px-1 text-[9px] text-muted" title={`Sub-página: ${e.page}`}>{e.page}</span> : null}
                {e.target === "_blank" ? <ExternalIcon className={`size-3 shrink-0 text-muted ${e.page ? "" : "ml-auto"}`} aria-label="Abre em nova aba" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
