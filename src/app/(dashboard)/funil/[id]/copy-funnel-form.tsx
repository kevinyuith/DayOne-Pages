"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { copyTemplateToDomain } from "@/app/(dashboard)/dominios/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SELECT_BASE } from "@/components/ui/field";

/** Copia o funil para um domínio (nova página, publicada) e abre a cópia no editor. */
export function CopyFunnelForm({ funnelId, domains }: { funnelId: string; domains: { id: string; domain: string }[] }) {
  const router = useRouter();
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!domains.length) return null;
  const onCopy = () =>
    start(async () => {
      setError(null);
      const r = await copyTemplateToDomain(domainId, funnelId);
      if (!r.ok) return setError(r.reason);
      router.push(`/dominios/${domainId}/paginas/${r.pageId}`);
    });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="Domain" className={`${SELECT_BASE} h-9 w-56 text-sm`} disabled={pending}>
          {domains.map((d) => (
            <option key={d.id} value={d.id}>
              {d.domain}
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" onClick={onCopy} disabled={pending || !domainId}>
          {pending ? "Copying…" : "Copy to domain"}
        </Button>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
