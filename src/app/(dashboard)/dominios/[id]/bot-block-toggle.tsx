"use client";

import { useState, useTransition } from "react";
import { CHECKBOX_CLASS } from "@/components/ui/field";
import { setBotBlock } from "../actions";

/**
 * Interruptor "bloquear bots/conexões suspeitas" do domínio. Salva na hora,
 * como o select de página padrão. É independente do filtro: bloqueia (403),
 * nunca troca a página.
 */
export function BotBlockToggle({ domainId, value }: { domainId: string; value: boolean }) {
  const [on, setOn] = useState(value);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={pending}
          className={CHECKBOX_CLASS}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            start(async () => {
              const r = await setBotBlock(domainId, next);
              if (r.ok) {
                setError(null);
              } else {
                setOn(!next); // reverte o visual se a gravação falhou
                setError(r.reason);
              }
            });
          }}
        />
        Bloquear bots e conexões suspeitas
      </label>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}
