"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, SELECT_CLASS } from "@/components/ui/field";
import { VENDOR_PLATFORM_LABELS, isVendorPlatform } from "@/lib/pages/types";
import { createUpsellFunnel } from "./actions";

/** Picks a vendor page without a funnel and creates its funnel (Upsell 1–3 and the Thank you page), then opens it. */
export function NewUpsellFunnel({ pages }: { pages: { id: string; name: string; platform: string | null }[] }) {
  const router = useRouter();
  const [pageId, setPageId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (pages.length === 0) {
    return <p className="mt-2 text-sm text-muted">Every vendor page already has an upsell funnel.</p>;
  }

  const create = () =>
    start(async () => {
      setError(null);
      const r = await createUpsellFunnel(pageId);
      if (r.ok) router.push(`/upsells/${r.id}`);
      else setError(r.reason);
    });

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Vendor page" className="min-w-0 sm:flex-1">
          <select value={pageId} onChange={(e) => setPageId(e.target.value)} disabled={pending} className={SELECT_CLASS}>
            <option value="" disabled>
              Choose…
            </option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.platform && isVendorPlatform(p.platform) && !p.name.includes(VENDOR_PLATFORM_LABELS[p.platform]) ? ` · ${VENDOR_PLATFORM_LABELS[p.platform]}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Button type="button" onClick={create} disabled={pending || !pageId} className="sm:shrink-0">
          {pending ? "Creating…" : "Create"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
