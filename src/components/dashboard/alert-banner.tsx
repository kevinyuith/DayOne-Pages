"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRightIcon, CloseIcon, WarningIcon } from "@/components/icons";

/**
 * Single-line notice at the top of the dashboard: shows up when there are active
 * domains that have not passed the DNS check yet — a real signal, from the database.
 * Goes away when dismissed; since it reflects an unresolved condition, it comes back
 * on reload.
 */
export function AlertBanner({ attentionCount }: { attentionCount: number }) {
  const [dismissed, setDismissed] = useState(false);

  if (attentionCount <= 0 || dismissed) return null;

  const plural = attentionCount === 1 ? "domain needs" : "domains need";

  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] py-2 pl-3.5 pr-2 text-sm sm:items-center"
    >
      <WarningIcon className="mt-0.5 size-4 shrink-0 text-amber-600 sm:mt-0 dark:text-amber-400" aria-hidden />
      {/* On phones the link drops below the text; from sm width up it stays on the same line. */}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
        <p className="min-w-0 flex-1">
          <span className="font-medium">
            {attentionCount} {plural} DNS verification.
          </span>{" "}
          <span className="text-muted">Point the DNS and run the check on each domain.</span>
        </p>
        <Link
          href="/domains"
          className="-ml-2 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium text-amber-700 transition-colors hover:bg-amber-500/10 sm:ml-0 dark:text-amber-300"
        >
          Review domains
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <CloseIcon className="size-4" />
      </button>
    </div>
  );
}
