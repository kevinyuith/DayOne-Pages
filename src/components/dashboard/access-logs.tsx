import { Badge } from "@/components/ui/badge";
import type { HitRow } from "@/lib/pages/queries";

/** Rótulo + tom do resultado de um hit. */
export const OUTCOME_BADGE: Record<string, { label: string; tone: "success" | "info" | "danger" | "warning" | "neutral" }> = {
  served: { label: "Served", tone: "success" },
  redirect: { label: "Redirect", tone: "info" },
  blocked: { label: "Blocked", tone: "danger" },
  bot: { label: "Bot", tone: "warning" },
  notfound: { label: "404", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
  other: { label: "Other", tone: "neutral" },
};

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Os últimos requests servidos. Sem dado, mostra um estado vazio honesto. */
export function AccessLogs({ hits }: { hits: HitRow[] }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">Access Logs</h2>
      <p className="mt-0.5 text-sm text-muted">Latest request activity</p>

      {hits.length === 0 ? (
        <div className="mt-5 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium">No activity yet</p>
          <p className="max-w-sm text-xs text-muted">Requests show up here as the delivery server logs them.</p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium text-muted">
                <th className="pb-2 pr-3 font-medium">Time</th>
                <th className="pb-2 pr-3 font-medium">Request</th>
                <th className="pb-2 pr-3 font-medium">Geo</th>
                <th className="pb-2 pr-3 font-medium">Device</th>
                <th className="pb-2 pr-3 font-medium">IP</th>
                <th className="pb-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="sensitive">
              {hits.map((h, i) => {
                const o = OUTCOME_BADGE[h.outcome] ?? OUTCOME_BADGE.other;
                return (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3 tabular-nums text-muted">{timeFmt.format(new Date(h.created_at))}</td>
                    <td className="py-2 pr-3">
                      <span className="font-mono text-xs">{h.host}</span>
                      <span className="font-mono text-xs text-muted">{h.path}</span>
                    </td>
                    <td className="py-2 pr-3 text-muted">{h.country ?? "—"}</td>
                    <td className="py-2 pr-3 text-muted">{h.device ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-muted">{h.ip ?? "—"}</td>
                    <td className="py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <Badge tone={o.tone}>{o.label}</Badge>
                        {h.is_bot ? <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">bot</span> : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
