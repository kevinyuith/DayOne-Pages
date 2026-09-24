"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { INPUT_BASE } from "@/components/ui/field";
import type { PageSlugSummary } from "@/lib/pages/types";

/** Painel "Pages": as slugs da página, criar nova e ações sobre a atual. */
export function PagesPanel({
  slugHref,
  slugs,
  currentSlugId,
  currentActive,
  busy,
  onNewSlug,
  onRename,
  onToggle,
  onRemove,
}: {
  /** URL de cada slug (template e página de domínio moram em rotas diferentes). */
  slugHref: (slugId: string) => string;
  slugs: PageSlugSummary[];
  currentSlugId: string;
  currentActive: boolean;
  busy: boolean;
  onNewSlug: (e: React.FormEvent<HTMLFormElement>) => void;
  onRename: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Pages</div>
        <p className="mt-0.5 text-[11px] text-muted">Each slug has its own HTML.</p>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto p-2">
        {slugs.map((s) => (
          <li key={s.id}>
            <Link
              href={slugHref(s.id)}
              aria-current={s.id === currentSlugId ? "page" : undefined}
              className={[
                "block truncate rounded-lg px-2 py-1.5 font-mono text-xs",
                s.id === currentSlugId ? "bg-accent/10 text-accent" : "text-foreground hover:bg-foreground/5",
                s.is_active ? "" : "line-through opacity-60",
              ].join(" ")}
              title={s.is_active ? s.slug : `${s.slug} (inactive)`}
            >
              {s.slug}
            </Link>
          </li>
        ))}
      </ul>
      <form onSubmit={onNewSlug} className="flex gap-1 border-t border-border p-2">
        <input name="slug" placeholder="/new" disabled={busy} className={`${INPUT_BASE} h-8 w-full font-mono text-xs`} />
        <Button type="submit" size="sm" variant="secondary" disabled={busy}>
          +
        </Button>
      </form>
      <div className="flex flex-wrap gap-1 border-t border-border p-2">
        <Button size="sm" variant="ghost" onClick={onRename} disabled={busy}>
          Rename
        </Button>
        <Button size="sm" variant="ghost" onClick={onToggle} disabled={busy}>
          {currentActive ? "Deactivate" : "Activate"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>
          Remove
        </Button>
      </div>
    </div>
  );
}
