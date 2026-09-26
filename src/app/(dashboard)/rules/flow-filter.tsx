"use client";

import { useRouter } from "next/navigation";
import { ChevronDownIcon } from "@/components/icons";

/**
 * Filters the rules by Flow (the rules' tags): a `?flow=` in the URL. Changing
 * it navigates; "All flows" clears it. Server-read in page.tsx.
 */
export function FlowFilter({ flows, value }: { flows: string[]; value: string | null }) {
  const router = useRouter();
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Flow</span>
      <select
        value={value ?? ""}
        onChange={(e) => router.push(e.target.value ? `/rules?flow=${encodeURIComponent(e.target.value)}` : "/rules")}
        className={`appearance-none rounded-lg border border-border bg-surface py-2 pl-3 pr-9 text-sm font-medium transition-colors hover:text-foreground ${value ? "text-foreground" : "text-muted"}`}
      >
        <option value="">All flows</option>
        {flows.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
    </label>
  );
}
