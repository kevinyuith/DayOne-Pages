"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";

/**
 * A button that calls an already "bound" server action (`action.bind(null, id)`)
 * and shows pending state and errors in place. Optional confirmation before calling.
 */
export function RowAction({
  action,
  label,
  pendingLabel,
  confirm,
  variant = "secondary",
  size = "sm",
  onDone,
  redirectTo,
}: {
  action: () => Promise<ActionResult<object>>;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  onDone?: (result: ActionResult<object>) => void;
  /** Where to go after a success (e.g. removing the record from its own detail screen). */
  redirectTo?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant={variant}
        size={size}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setError(null);
          start(async () => {
            const result = await action();
            if (!result.ok) setError(result.reason);
            onDone?.(result);
            if (result.ok && redirectTo) {
              router.push(redirectTo);
              // The destination may have been prefetched before the mutation; refresh ensures fresh data.
              router.refresh();
            }
          });
        }}
      >
        {pending ? (pendingLabel ?? "…") : label}
      </Button>
      {error ? (
        <span role="alert" className="max-w-xs text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}
