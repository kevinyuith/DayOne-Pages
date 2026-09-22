"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type DnsResult = {
  ip: string;
  hostname: string | null;
  loading?: boolean;
};

export function DnsResolver() {
  const [results, setResults] = useState<DnsResult[]>([]);
  const [ip, setIp] = useState("");
  const [loading, setLoading] = useState(false);

  const handleResolve = async () => {
    if (!ip.trim()) return;

    const ipValue = ip.trim();
    setLoading(true);

    // Adiciona resultado temporário com loading
    setResults((prev) => [{ ip: ipValue, hostname: null, loading: true }, ...prev]);

    try {
      const res = await fetch("/api/reverse-dns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: ipValue }),
      });

      if (!res.ok) throw new Error("Failed to resolve");

      const { hostname } = await res.json();
      setResults((prev) => [
        { ip: ipValue, hostname },
        ...prev.slice(1), // Remove o resultado temporário
      ]);
    } catch {
      setResults((prev) => [
        { ip: ipValue, hostname: null },
        ...prev.slice(1), // Remove o resultado temporário
      ]);
    } finally {
      setLoading(false);
      setIp("");
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleResolve();
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-base font-semibold mb-4">Reverse DNS Lookup</h2>
      <p className="text-sm text-muted mb-4">Descubra o hostname de um IP para identificar servidores de bot</p>

      <div className="flex gap-2 mb-4">
        <Input
          placeholder="Ex: 1.2.3.4"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onKeyPress={handleKeyPress}
          disabled={loading}
        />
        <Button onClick={handleResolve} disabled={loading || !ip.trim()}>
          {loading ? "Resolvendo..." : "Resolver"}
        </Button>
      </div>

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((result, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border border-border/60 p-3 text-sm">
              <span className="font-mono">{result.ip}</span>
              {result.loading ? (
                <span className="text-muted">Resolvendo...</span>
              ) : result.hostname ? (
                <span className="font-mono text-accent">{result.hostname}</span>
              ) : (
                <span className="text-muted italic">Sem hostname</span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
