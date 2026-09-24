import Link from "next/link";
import { ArrowRightIcon, DesktopIcon, MobileIcon, TabletIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { APP_TZ } from "@/lib/time-zone";
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

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: APP_TZ });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: APP_TZ });
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

const DEVICE: Record<string, { label: string; icon: typeof DesktopIcon }> = {
  desktop: { label: "Desktop", icon: DesktopIcon },
  mobile: { label: "Mobile", icon: MobileIcon },
  tablet: { label: "Tablet", icon: TabletIcon },
};

function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const th = "px-3 py-2 text-left text-xs font-medium text-muted first:pl-5 last:pr-5";
const td = "px-3 py-2.5 first:pl-5 last:pr-5";
// País, dispositivo e IP só a partir de md: no celular a linha fica em hora, pedido e resultado.
const wide = "hidden md:table-cell";

/**
 * Os últimos requests do período filtrado. Tabela de ponta a ponta no cartão,
 * com o caminho completo no title quando a linha corta. Sem dado, mostra um
 * estado vazio honesto (e diz se é o filtro). `showDate` põe o dia antes da
 * hora (períodos de mais de um dia).
 */
export function AccessLogs({ hits, filtered = false, showDate = false }: { hits: HitRow[]; filtered?: boolean; showDate?: boolean }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-start justify-between gap-3 px-5 pb-4 pt-5">
        <div>
          <h2 className="text-base font-semibold">Recent requests</h2>
          <p className="mt-0.5 text-sm text-muted">
            {hits.length > 0 ? `The ${hits.length} most recent in this period` : "Latest request activity"}
          </p>
        </div>
        <Link
          href="/logs"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          All logs
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>

      {hits.length === 0 ? (
        <div className="mx-5 mb-5 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium">{filtered ? "No matching requests" : "No activity yet"}</p>
          <p className="max-w-sm text-xs text-muted">
            {filtered ? "Nothing in this period matches the current filters." : "Requests show up here as the delivery server logs them."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm md:min-w-[720px]">
            <thead className="border-y border-border bg-foreground/[0.025]">
              <tr>
                <th scope="col" className={th}>Time</th>
                <th scope="col" className={th}>Request</th>
                <th scope="col" className={`${th} ${wide}`}>Country</th>
                <th scope="col" className={`${th} ${wide}`}>Device</th>
                <th scope="col" className={`${th} ${wide}`}>IP</th>
                <th scope="col" className={th}>Result</th>
              </tr>
            </thead>
            <tbody className="sensitive">
              {hits.map((h, i) => {
                const o = OUTCOME_BADGE[h.outcome] ?? OUTCOME_BADGE.other;
                const d = h.device ? DEVICE[h.device] : null;
                const DeviceIcon = d?.icon;
                const at = new Date(h.created_at);
                return (
                  <tr key={i} className="border-b border-border/60 transition-colors last:border-0 hover:bg-foreground/[0.02]">
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {showDate ? <span className="mr-1.5 hidden text-muted sm:inline">{dayFmt.format(at)}</span> : null}
                      {timeFmt.format(at)}
                    </td>
                    <td className={td}>
                      <p className="max-w-[7.5rem] truncate font-mono text-xs sm:max-w-[20rem] xl:max-w-[32rem]" title={`${h.host}${h.path}`}>
                        <span>{h.host}</span>
                        <span className="text-muted">{h.path}</span>
                      </p>
                    </td>
                    <td className={`${td} ${wide} text-muted`}>
                      {h.country ? (
                        <abbr title={countryName(h.country)} className="no-underline">
                          {h.country}
                        </abbr>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={`${td} ${wide} whitespace-nowrap text-muted`}>
                      {d && DeviceIcon ? (
                        <span className="inline-flex items-center gap-1.5">
                          <DeviceIcon className="size-3.5" aria-hidden />
                          {d.label}
                        </span>
                      ) : (
                        (h.device ?? "—")
                      )}
                    </td>
                    <td className={`${td} ${wide} whitespace-nowrap font-mono text-xs tabular-nums text-muted`}>{h.ip ?? "—"}</td>
                    <td className={`${td} md:whitespace-nowrap`}>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Badge tone={o.tone}>{o.label}</Badge>
                        {/* O resultado "Bot" já diz que é bot; a etiqueta é para os outros resultados. */}
                        {h.is_bot && h.outcome !== "bot" ? (
                          <span className="inline-flex items-center rounded-md bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">
                            Bot
                          </span>
                        ) : null}
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
