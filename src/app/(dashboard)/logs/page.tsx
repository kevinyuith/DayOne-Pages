import type { Metadata } from "next";
import Link from "next/link";
import { OUTCOME_BADGE } from "@/components/dashboard/access-logs";
import { EmptyState } from "@/components/empty-state";
import { ChevronDownIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { RowAction } from "@/components/row-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { languagesFromHeader } from "@/lib/accept-language";
import { connectionType } from "@/lib/connection";
import { browserFromUA, osFromUA } from "@/lib/user-agent";
import { normalizeHost } from "@/lib/pages/normalize";
import { listDomains, listHits, unregisteredHosts, type HitLogRow } from "@/lib/pages/queries";
import { APP_TZ } from "@/lib/time-zone";
import { registerSeenDomain } from "../domains/actions";

export const metadata: Metadata = {
  title: "Logs",
};

const PAGE_SIZE = 100;

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "medium", timeZone: APP_TZ });
const loadFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Every request logged in pages.hits, with all columns, newest to oldest.
 * Filter by domain (?domain=<id>, GET form, no JS) and cursor pagination
 * (?before=<id>). An unregistered host gets a button to register it right
 * there.
 */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { domain, before } = await searchParams;
  const domains = await listDomains();
  const selected = typeof domain === "string" && domains.some((d) => d.id === domain) ? domain : null;
  const beforeId = typeof before === "string" && /^\d+$/.test(before) ? Number(before) : null;
  const [{ rows: hits, hasMore }, unregistered] = await Promise.all([
    listHits({ domainId: selected, beforeId, limit: PAGE_SIZE }),
    unregisteredHosts(),
  ]);
  // Unregistered hosts that can be registered from here (the "looks like a domain" rules live in the SQL).
  const registrable = new Set(unregistered.map((u) => u.domain));

  const pageHref = (cursor: number | null) => {
    const qs = new URLSearchParams();
    if (selected) qs.set("domain", selected);
    if (cursor) qs.set("before", String(cursor));
    const s = qs.toString();
    return s ? `/logs?${s}` : "/logs";
  };

  return (
    <>
      <PageHeader title="Logs" />

      <form method="get" className="mb-6 flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Domain</span>
          <select
            name="domain"
            defaultValue={selected ?? ""}
            className="appearance-none rounded-lg border border-border bg-surface py-2 pl-3 pr-9 text-sm font-medium text-muted transition-colors hover:text-foreground"
          >
            <option value="">All domains</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.domain}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>

      {hits.length === 0 ? (
        <EmptyState
          title={beforeId ? "No older requests" : "No requests logged"}
          description="Requests show up here as the delivery server logs them."
        />
      ) : (
        <Table className="min-w-[3360px]">
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Request</Th>
              <Th>Parameters</Th>
              <Th>Domain</Th>
              <Th>Slug</Th>
              <Th>Decision</Th>
              <Th className="text-right">Status</Th>
              <Th>Result</Th>
              <Th>Rule</Th>
              <Th>Flow</Th>
              <Th>Reason</Th>
              <Th title="The browser reported that the page finished loading (load event). Pings, prefetches, link-preview bots and curl don't report. — = not applicable (redirect, 404, file or old record).">
                Loaded
              </Th>
              <Th>Interaction</Th>
              <Th>Country</Th>
              <Th>State</Th>
              <Th>Language</Th>
              <Th>Device</Th>
              <Th>Browser</Th>
              <Th title="From the User-Agent. macOS, Windows 11 and Chrome on Android hide the real version, so only the name shows.">OS</Th>
              <Th>Referrer</Th>
              <Th>IP</Th>
              <Th>Hostname</Th>
              <Th>ASN</Th>
              <Th title="Estimated from the ASN (approximate). The server can't tell WiFi from cable.">Connection</Th>
              <Th>User-Agent</Th>
              <Th>Cookies</Th>
            </tr>
          </thead>
          <tbody className="sensitive">
            {hits.map((h) => {
              const o = OUTCOME_BADGE[h.outcome] ?? OUTCOME_BADGE.other;
              return (
                <Tr key={h.id}>
                  <Td className="whitespace-nowrap tabular-nums text-muted" title={`#${h.id}`}>
                    {dateFmt.format(new Date(h.created_at))}
                  </Td>
                  <Td className="max-w-[280px] break-all">
                    <span className="font-mono text-xs">{h.host}</span>
                    <span className="font-mono text-xs text-muted">{h.path}</span>
                  </Td>
                  <Td className="min-w-[200px] max-w-[320px] font-mono text-[11px] leading-snug text-muted">
                    {h.query ? (
                      <span className="line-clamp-3 whitespace-pre-line break-all" title={h.query}>
                        {Array.from(new URLSearchParams(h.query), ([k, v]) => `${k}=${v}`).join("\n")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="min-w-[160px] max-w-[220px] break-all font-mono text-xs text-muted">
                    {h.domain ? (
                      h.domain
                    ) : registrable.has(normalizeHost(h.host)) ? (
                      <span className="flex flex-col items-start gap-1">
                        <span className="text-foreground">{normalizeHost(h.host)}</span>
                        <span className="font-sans text-[11px] text-amber-600 dark:text-amber-400">not registered</span>
                        <span className="break-normal font-sans">
                          <RowAction action={registerSeenDomain.bind(null, h.host)} label="Register" pendingLabel="Registering…" />
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="min-w-[120px] max-w-[220px] text-xs text-muted">
                    {h.slug ? (
                      <>
                        <span className="break-all font-mono text-foreground">{h.slug}</span>
                        {h.page_name ? (
                          <span className="block truncate" title={h.page_name}>
                            {h.page_name}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="min-w-[320px] max-w-[400px] font-mono text-xs text-muted" title={h.route_id ? `route ${h.route_id}` : undefined}>
                    <span className="whitespace-nowrap">{h.decision || "—"}</span>
                    {h.redirect_url ? (
                      <span className="mt-0.5 line-clamp-3 break-all text-[11px] leading-snug text-foreground" title={h.redirect_url}>
                        → {h.redirect_url}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-right tabular-nums text-muted">{h.status_code ?? "—"}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone={o.tone}>{o.label}</Badge>
                      {h.is_bot ? <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">bot</span> : null}
                    </span>
                  </Td>
                  <Td className="min-w-[140px] max-w-[220px]">
                    {h.rule_label || h.rule ? (
                      <span className="flex flex-col items-start gap-0.5">
                        {h.rule_label ? <Badge tone={h.rule_label.toLowerCase() === "bot" ? "danger" : "warning"}>{h.rule_label}</Badge> : null}
                        {h.rule ? <span className="text-xs font-medium">{h.rule}</span> : null}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className="min-w-[100px] max-w-[200px]">
                    {h.rule_tags?.length ? (
                      <span className="flex flex-wrap gap-1">
                        {h.rule_tags.map((t) => (
                          <span key={t} className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-xs">
                            {t}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className="min-w-[140px] max-w-[260px] text-xs">{h.rule_reason || <span className="text-muted">—</span>}</Td>
                  <Td className="whitespace-nowrap">
                    {h.load ? (
                      <Badge tone="success">✓{h.load.load_ms !== null ? ` ${loadFmt.format(h.load.load_ms / 1000)}s` : ""}</Badge>
                    ) : h.visit_id ? (
                      <span className="text-xs text-muted" title="The browser didn't report: ping, prefetch, bot, blocked JavaScript or the visitor left before it loaded.">
                        no
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Interaction hit={h} />
                  </Td>
                  <Td className="text-muted">{h.country || "—"}</Td>
                  <Td className="whitespace-nowrap text-muted">{h.region || "—"}</Td>
                  <Td className="whitespace-nowrap" title={h.accept_language ?? undefined}>
                    <Languages header={h.accept_language} />
                  </Td>
                  <Td className="text-muted">{h.device || "—"}</Td>
                  <Td className="whitespace-nowrap text-muted">{browserFromUA(h.user_agent) ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-muted">{osFromUA(h.user_agent) ?? "—"}</Td>
                  <Td className="max-w-[180px] break-all text-muted">{h.referrer_host || "—"}</Td>
                  <Td className="whitespace-nowrap font-mono text-xs text-muted">{h.ip || "—"}</Td>
                  <Td className="max-w-[220px] break-all font-mono text-xs text-muted">{h.hostname || "—"}</Td>
                  <Td className="min-w-[160px] max-w-[240px] text-xs text-muted">
                    {h.asn ? (
                      <>
                        <span className="font-mono text-foreground">AS{h.asn}</span>
                        {h.as_name ? (
                          <span className="block truncate" title={h.as_name}>
                            {h.as_name}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{connectionType(h.asn, h.as_name) ?? "—"}</Td>
                  <Td className="min-w-[280px] max-w-[420px] break-all font-mono text-[11px] leading-snug text-muted">{h.user_agent || "—"}</Td>
                  <Td className="min-w-[240px] max-w-[360px] font-mono text-[11px] leading-snug text-muted">
                    {h.cookies ? (
                      <span className="line-clamp-3 break-all" title={h.cookies}>
                        {h.cookies}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {beforeId || hasMore ? (
        <nav className="mt-4 flex items-center justify-between text-sm">
          {beforeId ? (
            <Link href={pageHref(null)} className="font-medium text-muted hover:text-foreground">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Link href={pageHref(hits[hits.length - 1].id)} className="font-medium text-muted hover:text-foreground">
              Older →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}

/** The visitor's first interaction (kind and time to it) and whether they clicked out of the page. */
function Interaction({ hit }: { hit: HitLogRow }) {
  if (!hit.interaction && !hit.clicked_at) return <span className={hit.visit_id ? "text-xs text-muted" : "text-muted"}>{hit.visit_id ? "no" : "—"}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      {hit.interaction ? (
        <Badge tone="success">
          {hit.interaction}
          {hit.interaction_ms !== null ? ` ${loadFmt.format(hit.interaction_ms / 1000)}s` : ""}
        </Badge>
      ) : null}
      {hit.clicked_at ? <Badge tone="info">clicked</Badge> : null}
    </span>
  );
}

/** The click's languages, most preferred first: the main one highlighted, the others after it (the full header on hover). */
function Languages({ header }: { header: string | null }) {
  const [main, ...rest] = languagesFromHeader(header);
  if (!main) return <span className="text-muted">{header ? <span className="font-mono text-[11px]">{header.slice(0, 40)}</span> : "—"}</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-xs font-semibold">{main}</span>
      {rest.length ? <span className="text-xs text-muted">{rest.join(" · ")}</span> : null}
    </span>
  );
}
