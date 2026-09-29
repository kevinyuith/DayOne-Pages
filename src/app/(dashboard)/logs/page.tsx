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
import { platformLabel } from "@/lib/pages/dashboard-filters";
import { HIT_FILTER_OPTIONS, hitFilterParams, parseHitFilters } from "@/lib/pages/hit-filters";
import { connectionType } from "@/lib/connection";
import { browserFromUA, osFromUA } from "@/lib/user-agent";
import { normalizeHost } from "@/lib/pages/normalize";
import { FUNNEL_DECISIONS, hitPlatforms, listDomains, listHits, unregisteredHosts, type HitLogRow } from "@/lib/pages/queries";
import { listRules } from "@/lib/pages/rules";
import { APP_TZ } from "@/lib/time-zone";
import { registerSeenDomain } from "../domains/actions";

export const metadata: Metadata = {
  title: "Logs",
};

const PAGE_SIZE = 100;
/** The Platform filter lists the platforms (sub11) seen in this window. */
const PLATFORM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "medium", timeZone: APP_TZ });
const loadFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Every request logged in pages.hits, with all columns, newest to oldest.
 * Filters in a GET form, no JS (?domain=<id> and hit-filters.ts: platform,
 * result, rule — a label or one rule's id —, flow, unique, funnel, interaction,
 * device, country, ip) and cursor pagination (?before=<id>) that keeps them. An
 * unregistered host gets a button to register it right there.
 */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Dynamic Server Component: reading the clock per request is intentional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const params = await searchParams;
  const { domain, before } = params;
  const filters = parseHitFilters(params);
  const domains = await listDomains();
  const selected = typeof domain === "string" && domains.some((d) => d.id === domain) ? domain : null;
  const beforeId = typeof before === "string" && /^\d+$/.test(before) ? Number(before) : null;
  const filtered = selected !== null || hitFilterParams(filters).length > 0;
  const [{ rows: hits, hasMore }, unregistered, rules, platforms] = await Promise.all([
    listHits({ domainId: selected, beforeId, limit: PAGE_SIZE, filters }),
    unregisteredHosts(),
    listRules(),
    hitPlatforms(new Date(nowMs - PLATFORM_WINDOW_MS)),
  ]);
  // The rules' flows (tags), plus the one in the URL if no rule has it any more (old hits still do).
  const flows = [...new Set([...rules.flatMap((r) => r.tags), ...(filters.flow ? [filters.flow] : [])])].sort((a, b) => a.localeCompare(b));
  // Every rule for the Rule select (a name that repeats gets its reason); a rule in the URL that no longer exists shows as deleted.
  const names = new Map<string, number>();
  for (const r of rules) names.set(r.name, (names.get(r.name) ?? 0) + 1);
  const ruleOptions = rules.map((r) => [r.id, (names.get(r.name) ?? 0) > 1 && r.reason ? `${r.name} · ${r.reason}` : r.name] as const);
  if (filters.ruleId && !rules.some((r) => r.id === filters.ruleId)) ruleOptions.push([filters.ruleId, "Deleted rule"] as const);
  // The platforms seen lately, plus the one in the URL if it isn't among them.
  const platformOptions = [...new Set([...platforms.map((p) => p.platform), ...(filters.platform ? [filters.platform] : [])])];
  // Unregistered hosts that can be registered from here (the "looks like a domain" rules live in the SQL).
  const registrable = new Set(unregistered.map((u) => u.domain));

  const pageHref = (cursor: number | null) => {
    const qs = new URLSearchParams();
    if (selected) qs.set("domain", selected);
    for (const [k, v] of hitFilterParams(filters)) qs.set(k, v);
    if (cursor) qs.set("before", String(cursor));
    const s = qs.toString();
    return s ? `/logs?${s}` : "/logs";
  };

  return (
    <>
      <PageHeader title="Logs" />

      <form method="get" className="mb-6 flex flex-wrap items-center gap-2">
        <FilterSelect name="domain" label="Domain" value={selected} options={domains.map((d) => [d.id, d.domain] as const)} all="All domains" />
        <FilterSelect name="platform" label="Platform" value={filters.platform} options={platformOptions.map((p) => [p, platformLabel(p)] as const)} all="All platforms" />
        <FilterSelect name="result" label="Result" value={filters.result} options={HIT_FILTER_OPTIONS.result} all="All results" />
        <FilterSelect
          name="rule"
          label="Rule"
          value={filters.ruleId ?? filters.rule}
          options={HIT_FILTER_OPTIONS.rule}
          groups={ruleOptions.length ? [{ label: "Rules", options: ruleOptions }] : undefined}
          all="All rules"
        />
        <FilterSelect name="flow" label="Flow" value={filters.flow} options={flows.map((t) => [t, t] as const)} all="All flows" />
        <FilterSelect name="unique" label="Unique" value={filters.unique} options={HIT_FILTER_OPTIONS.unique} all="Unique and repeat" />
        <FilterSelect name="funnel" label="Funnel" value={filters.funnel} options={HIT_FILTER_OPTIONS.funnel} all="Funnel: all" />
        <FilterSelect name="interaction" label="Interaction" value={filters.interaction} options={HIT_FILTER_OPTIONS.interaction} all="Interaction: all" />
        <FilterSelect name="device" label="Device" value={filters.device} options={HIT_FILTER_OPTIONS.device} all="All devices" />
        <FilterInput name="country" label="Country" value={filters.country} placeholder="Country" maxLength={2} className="w-24 uppercase placeholder:normal-case" />
        <FilterInput name="ip" label="IP" value={filters.ip} placeholder="IP" maxLength={45} className="w-44 font-mono" />
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {filtered ? (
          <Link href="/logs" className="px-2 text-sm font-medium text-muted hover:text-foreground">
            Clear
          </Link>
        ) : null}
      </form>

      {hits.length === 0 ? (
        <EmptyState
          title={beforeId ? "No older requests" : filtered ? "No requests match these filters" : "No requests logged"}
          description="Requests show up here as the delivery server logs them."
        />
      ) : (
        <Table className="min-w-[3800px] [&_td]:px-6 [&_td]:py-3 [&_th]:whitespace-nowrap [&_th]:px-6 [&_th]:py-3">
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Request</Th>
              <Th>Parameters</Th>
              <Th>Domain</Th>
              <Th>Slug</Th>
              <Th className="text-right">Status</Th>
              <Th>Result</Th>
              <Th title="The first click with this IP and browser (User-Agent) on this domain in 30 days.">Unique</Th>
              <Th>Rule</Th>
              <Th>Flow</Th>
              <Th>Reason</Th>
              <Th title="The browser reported that the page finished loading (load event). Pings, prefetches, link-preview bots and curl don't report. — = not applicable (redirect, 404, file or old record).">
                Loaded
              </Th>
              <Th>Interaction</Th>
              <Th title="What JavaScript could tell about the device on the funnel page (the beacon; informational only): webdriver, pointer, touch, and the session's event counts. Hover for the full JSON.">
                Signals
              </Th>
              <Th>Time on page</Th>
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
                  <Td className="min-w-[260px] max-w-[420px] font-mono text-[11px] leading-snug text-muted">
                    {h.query ? (
                      // Every parameter on its own line; a long value is cut on its line, whole on hover.
                      <ul>
                        {Array.from(new URLSearchParams(h.query), ([k, v], i) => (
                          <li key={i} className="truncate" title={`${k}=${v}`}>
                            <span className="text-foreground">{k}</span>={v}
                          </li>
                        ))}
                      </ul>
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
                  <Td className="max-w-[220px] break-all font-mono text-xs">{h.slug || <span className="font-sans text-muted">—</span>}</Td>
                  <Td className="text-right tabular-nums text-muted">{h.status_code ?? "—"}</Td>
                  <Td className={h.redirect_url || h.page_id ? "min-w-[180px] max-w-[320px]" : undefined}>
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone={o.tone}>{o.label}</Badge>
                      {h.is_bot ? <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">bot</span> : null}
                    </span>
                    {h.page_name ? (
                      <span className="mt-0.5 block truncate text-xs font-medium" title={h.page_name}>
                        {h.page_name}
                      </span>
                    ) : h.page_id ? (
                      <span className="mt-0.5 block truncate text-xs text-muted">{(FUNNEL_DECISIONS as readonly (string | null)[]).includes(h.decision) && h.funnel ? `${h.funnel} · deleted page` : "Deleted page"}</span>
                    ) : null}
                    {h.redirect_url ? (
                      <span className="mt-0.5 line-clamp-3 break-all font-mono text-[11px] leading-snug text-muted" title={h.redirect_url}>
                        → {h.redirect_url}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {h.is_unique === null ? <span className="text-muted">—</span> : h.is_unique ? <Badge tone="success">unique</Badge> : <span className="text-xs text-muted">repeat</span>}
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
                  <Td className="min-w-[140px] max-w-[260px] text-xs">
                    {h.rule_reason ? h.rule_reason : h.gate_reason ? <span className="text-muted">{gateReason(h)}</span> : <span className="text-muted">—</span>}
                  </Td>
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
                  <Td className="min-w-[120px] max-w-[200px]">
                    <Signals hit={h} />
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">{h.duration_ms !== null ? formatDuration(h.duration_ms) : <span className="text-muted">—</span>}</Td>
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

const FILTER_CLASS = "rounded-lg border border-border bg-surface py-2 text-sm font-medium transition-colors hover:text-foreground";

/** A filter of the Logs' GET form; the first option (empty) is no filter. */
type FilterOptions = readonly (readonly [string, string])[];

function FilterSelect({
  name,
  label,
  value,
  options,
  groups,
  all,
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  options: FilterOptions;
  groups?: { label: string; options: FilterOptions }[];
  all: string;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select name={name} defaultValue={value ?? ""} className={`${FILTER_CLASS} appearance-none pl-3 pr-9 ${value ? "text-foreground" : "text-muted"}`}>
        <option value="">{all}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
        {groups?.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map(([v, text]) => (
              <option key={v} value={v}>
                {text}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
    </label>
  );
}

function FilterInput({ name, label, value, placeholder, maxLength, className }: { name: string; label: string; value: string | undefined; placeholder: string; maxLength: number; className: string }) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <input name={name} defaultValue={value ?? ""} placeholder={placeholder} maxLength={maxLength} autoComplete="off" className={`${FILTER_CLASS} px-3 text-foreground placeholder:text-muted ${className}`} />
    </label>
  );
}

/** Why a click didn't go to a funnel: by the slug/sub1, or by the domain's status. */
function gateReason(hit: HitLogRow): string {
  switch (hit.gate_reason) {
    case "slug_not_allowed":
      return "Slug not allowed";
    case "no_funnel_token":
      return "No [F…] in sub1";
    case "funnel_not_live":
      return `${hit.funnel ?? "Funnel"}: no live page`;
    case "domain_disabled":
      return "Domain: disabled";
    case "domain_locked":
      return "Domain: locked";
    case "domain_unlocked":
      return hit.funnel ? `${hit.funnel}: no live page (domain: unlocked)` : "Domain: unlocked, no [F…] in sub1";
    default:
      return "";
  }
}

/** A time on the page: "45s", "2m 13s", "1h 05m". */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
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

/** A signal value as a number (the beacon sends 0/1 for booleans). */
const sigNum = (s: Record<string, number | string | boolean>, k: string): number | null => {
  const v = s[k];
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : null;
};

/**
 * The beacon's device/behavior signals (informational only): red flags
 * (webdriver), device-vs-behavior mismatches (a mouse nobody moved, a
 * touchscreen nobody touched, no scroll) and the session's event counts.
 * The full JSON is in the tooltip.
 */
function Signals({ hit }: { hit: HitLogRow }) {
  const s = hit.signals;
  if (!s) return <span className="text-muted">—</span>;

  const hasCounts = ["mm", "md", "wh", "sc", "ts", "ky", "ck"].some((k) => sigNum(s, k) !== null);
  const flags: { label: string; tone: "danger" | "warning" }[] = [];
  if (sigNum(s, "wd") === 1) flags.push({ label: "webdriver", tone: "danger" });
  if ((sigNum(s, "aut") ?? 0) > 0) flags.push({ label: "automation", tone: "danger" });
  if (sigNum(s, "glsw") === 1) flags.push({ label: "software GL", tone: "danger" });
  if (hasCounts) {
    const fine = s.ptr === "fine";
    const touchDev = (sigNum(s, "mtp") ?? 0) > 0 || s.ptr === "coarse";
    if (fine && (sigNum(s, "mm") ?? 0) === 0 && (sigNum(s, "md") ?? 0) === 0) flags.push({ label: "no mouse", tone: "warning" });
    if (touchDev && (sigNum(s, "ts") ?? 0) === 0) flags.push({ label: "no touch", tone: "warning" });
    if ((sigNum(s, "wh") ?? 0) === 0 && (sigNum(s, "sc") ?? 0) === 0) flags.push({ label: "no scroll", tone: "warning" });
    // The mouse moved a lot but almost in a straight line, barely turning: a synthetic path.
    if ((sigNum(s, "mm") ?? 0) >= 10 && (sigNum(s, "str") ?? 0) >= 90 && (sigNum(s, "dc") ?? 0) <= 2) flags.push({ label: "straight mouse", tone: "warning" });
  }
  // No languages and no plugins, or an empty primary language: a headless hint.
  if (sigNum(s, "nl") === 0 && sigNum(s, "np") === 0) flags.push({ label: "headless?", tone: "warning" });

  const counts = ["mm", "md", "wh", "sc", "ts", "ky", "ck"].filter((k) => sigNum(s, k) !== null);
  const traj = ["str", "dc", "tp"].filter((k) => sigNum(s, k) !== null);
  return (
    <span className="flex flex-col items-start gap-0.5" title={JSON.stringify(s, null, 2)}>
      {flags.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {flags.map((f) => (
            <Badge key={f.label} tone={f.tone}>
              {f.label}
            </Badge>
          ))}
        </span>
      ) : null}
      {counts.length > 0 ? (
        <span className="whitespace-nowrap font-mono text-[11px] text-muted">{counts.map((k) => `${k} ${sigNum(s, k)}`).join(" · ")}</span>
      ) : flags.length === 0 ? (
        <span className="text-xs text-muted">{s.ptr === "fine" ? "mouse" : s.ptr === "coarse" ? "touch" : "—"}</span>
      ) : null}
      {traj.length > 0 ? (
        <span className="whitespace-nowrap font-mono text-[11px] text-muted" title="str = how straight the mouse path is (0–100; ~100 = a line), dc = direction changes, tp = teleports">
          {traj.map((k) => `${k} ${sigNum(s, k)}`).join(" · ")}
        </span>
      ) : null}
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
