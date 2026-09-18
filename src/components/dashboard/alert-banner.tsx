"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRightIcon, CloseIcon, WarningIcon } from "@/components/icons";

/**
 * Faixa de aviso no topo do dashboard, no lugar do banner de migração do
 * layout de referência. Aparece só quando há domínios ativos que ainda não
 * passaram na verificação de DNS — sinal real, vindo do banco. Some ao fechar;
 * como reflete uma condição ainda não resolvida, volta a aparecer no reload.
 */
export function AlertBanner({ attentionCount }: { attentionCount: number }) {
  const [dismissed, setDismissed] = useState(false);

  if (attentionCount <= 0 || dismissed) return null;

  const plural = attentionCount === 1 ? "domain needs" : "domains need";

  return (
    <div className="relative mb-6 overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-transparent p-4 pr-12">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <WarningIcon className="size-5" />
          </span>
          <div>
            <p className="text-sm font-semibold">
              Domains need attention
              <span className="ml-2 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                {attentionCount}
              </span>
            </p>
            <p className="mt-0.5 text-sm text-muted">
              {attentionCount} {plural} DNS verification. Point the DNS and run the check on each domain.
            </p>
          </div>
        </div>
        <Link
          href="/dominios"
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90"
        >
          View my domains
          <ArrowRightIcon className="size-4" />
        </Link>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <CloseIcon className="size-4" />
      </button>
    </div>
  );
}
