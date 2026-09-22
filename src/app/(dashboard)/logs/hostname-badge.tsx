"use client";

import { useState } from "react";

type HostnameBadgeProps = {
  ip: string | null;
  hostname: string | null;
};

export function HostnameBadge({ ip, hostname }: HostnameBadgeProps) {
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<string | null>(hostname);
  const [error, setError] = useState(false);

  if (!ip) return <span className="text-muted">—</span>;

  if (resolved) {
    return <span className="font-mono text-xs text-accent truncate" title={resolved}>{resolved}</span>;
  }

  const handleResolve = async (e: React.MouseEvent) => {
    e.preventDefault();
    setResolving(true);
    setError(false);

    try {
      const res = await fetch("/api/reverse-dns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip }),
      });

      if (!res.ok) throw new Error("Failed to resolve");

      const { hostname: result } = await res.json();
      setResolved(result);
    } catch {
      setError(true);
    } finally {
      setResolving(false);
    }
  };

  return (
    <button
      onClick={handleResolve}
      disabled={resolving}
      className={`font-mono text-xs px-2 py-1 rounded transition-colors ${
        error
          ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
          : "bg-muted/50 text-muted hover:bg-accent/20 hover:text-accent disabled:opacity-60"
      }`}
      title={error ? "Erro ao resolver" : "Clique para resolver"}
    >
      {resolving ? "..." : error ? "✕" : "Resolver"}
    </button>
  );
}
