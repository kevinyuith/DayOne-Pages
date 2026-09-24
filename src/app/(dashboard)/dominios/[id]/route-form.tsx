"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CHECKBOX_CLASS, Field, INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import {
  DEVICES,
  DEVICE_LABELS,
  QUERY_MODES,
  QUERY_MODE_LABELS,
  conditionsToForm,
  type QueryRuleRow,
} from "@/lib/pages/conditions";
import type { DomainRouteWithPage, PageOption } from "@/lib/pages/queries";
import {
  BLOCK_CODES,
  MATCH_TYPES,
  MATCH_TYPE_LABELS,
  PAGE_KIND_LABELS,
  PAGE_STATUS_LABELS,
  REDIRECT_CODES,
  ROUTE_ACTIONS,
  ROUTE_ACTION_LABELS,
  type MatchType,
  type RouteAction,
} from "@/lib/pages/types";
import { saveRoute, type RouteFormState } from "../actions";

/**
 * Formulário de rota. Os campos mudam com a ação e o tipo de casamento; o
 * resto é FormData puro lido por `saveRoute`. As linhas de parâmetro de URL
 * são listas paralelas (`query_key`, `query_mode`, `query_value`).
 */
export function RouteForm({
  domainId,
  pages,
  route,
  nextPriority,
  onDone,
}: {
  domainId: string;
  pages: PageOption[];
  route: DomainRouteWithPage | null;
  nextPriority: number;
  onDone: () => void;
}) {
  const initialConditions = conditionsToForm(route?.conditions);
  const [state, action, pending] = useActionState(saveRoute, { attempt: 0 } as RouteFormState);
  const [matchType, setMatchType] = useState<MatchType>(route?.match_type ?? "EXACT");
  const [routeAction, setRouteAction] = useState<RouteAction>(route?.action ?? "SERVE");
  const [pageId, setPageId] = useState<string>(route?.page_id ?? pages[0]?.id ?? "");
  const [queryRows, setQueryRows] = useState<QueryRuleRow[]>(initialConditions.query);

  useEffect(() => {
    if (state.savedId) onDone();
  }, [state.savedId, onDone]);

  const selectedPage = pages.find((p) => p.id === pageId);

  return (
    <form action={action} className="rounded-xl border border-accent/30 bg-surface p-5">
      <input type="hidden" name="domain_id" value={domainId} />
      {route ? <input type="hidden" name="route_id" value={route.id} /> : null}

      <h3 className="text-sm font-semibold">{route ? "Edit route" : "New route"}</h3>

      <div className="mt-4 grid gap-4 md:grid-cols-4">
        <Field label="Name (optional)" className="md:col-span-2">
          <input name="name" defaultValue={route?.name ?? ""} placeholder="E.g. September promo" className={INPUT_CLASS} disabled={pending} />
        </Field>
        <Field label="Priority" hint="Lower = evaluated first">
          <input name="priority" type="number" min={0} max={100000} defaultValue={nextPriority} required className={INPUT_CLASS} disabled={pending} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="is_active" defaultChecked={route?.is_active ?? true} className={CHECKBOX_CLASS} disabled={pending} />
          Active
        </label>
      </div>

      <fieldset className="mt-5">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Path</legend>
        <div className="mt-2 grid gap-4 md:grid-cols-4">
          <Field label="Match">
            <select name="match_type" value={matchType} onChange={(e) => setMatchType(e.target.value as MatchType)} className={SELECT_CLASS} disabled={pending}>
              {MATCH_TYPES.map((m) => (
                <option key={m} value={m}>
                  {MATCH_TYPE_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          {matchType !== "ANY" ? (
            <Field
              label={matchType === "REGEX" ? "Expression (POSIX, against the canonical path)" : "Path"}
              hint={matchType === "PREFIX" ? "Matches the path and everything below it (/br matches /br and /br/x)" : undefined}
              className="md:col-span-3"
            >
              <input
                name="path_pattern"
                defaultValue={route?.path_pattern ?? ""}
                placeholder={matchType === "REGEX" ? "^/(promo|offer)(/|$)" : "/promo"}
                className={`${INPUT_CLASS} font-mono`}
                disabled={pending}
              />
            </Field>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Action</legend>
        <div className="mt-2 grid gap-4 md:grid-cols-4">
          <Field label="What to do">
            <select name="action" value={routeAction} onChange={(e) => setRouteAction(e.target.value as RouteAction)} className={SELECT_CLASS} disabled={pending}>
              {ROUTE_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ROUTE_ACTION_LABELS[a]}
                </option>
              ))}
            </select>
          </Field>

          {routeAction === "SERVE" ? (
            <>
              <Field label="Page" className="md:col-span-2">
                <select name="page_id" value={pageId} onChange={(e) => setPageId(e.target.value)} className={SELECT_CLASS} disabled={pending}>
                  {pages.length === 0 ? <option value="">— copy a template to the domain first —</option> : null}
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {PAGE_KIND_LABELS[p.kind]}
                      {p.status !== "PUBLISHED" ? ` (${PAGE_STATUS_LABELS[p.status].toLowerCase()})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Page slug" hint="Empty = uses the request path as the slug">
                <select name="slug" defaultValue={route?.slug ?? ""} className={`${SELECT_CLASS} font-mono`} disabled={pending}>
                  <option value="">(request path)</option>
                  {(selectedPage?.slugs ?? []).map((s) => (
                    <option key={s.id} value={s.slug}>
                      {s.slug}
                      {s.is_active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : null}

          {routeAction === "REDIRECT" ? (
            <>
              <Field label="Destination URL" className="md:col-span-2">
                <input name="redirect_url" defaultValue={route?.redirect_url ?? ""} placeholder="https://destination.com/x" className={INPUT_CLASS} disabled={pending} />
              </Field>
              <Field label="Code">
                <select name="status_code" defaultValue={route?.status_code ?? 302} className={SELECT_CLASS} disabled={pending}>
                  {REDIRECT_CODES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm md:col-span-4">
                <input type="checkbox" name="preserve_query" defaultChecked={route?.preserve_query ?? true} className={CHECKBOX_CLASS} disabled={pending} />
                Keep the original query string (utm, gclid…)
              </label>
            </>
          ) : null}

          {routeAction === "BLOCK" ? (
            <Field label="Code">
              <select name="status_code" defaultValue={route?.status_code ?? 404} className={SELECT_CLASS} disabled={pending}>
                {BLOCK_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Conditions (all must match; empty = always)</legend>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <Field label="Countries (ISO-2, comma-separated)" hint="From Cloudflare's CF-IPCountry header">
            <input name="countries" defaultValue={initialConditions.countries} placeholder="BR, PT, US" className={`${INPUT_CLASS} uppercase`} disabled={pending} />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Devices</span>
            <div className="flex h-10 items-center gap-4">
              {DEVICES.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="devices" value={d} defaultChecked={initialConditions.devices.includes(d)} className={CHECKBOX_CLASS} disabled={pending} />
                  {DEVICE_LABELS[d]}
                </label>
              ))}
            </div>
          </div>
          <Field label="Referrer contains" className="md:col-span-2">
            <input name="referrer" defaultValue={initialConditions.referrer} placeholder="facebook.com" className={INPUT_CLASS} disabled={pending} />
          </Field>

          <div className="md:col-span-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted">URL parameters</span>
              <Button size="sm" variant="ghost" onClick={() => setQueryRows([...queryRows, { key: "", mode: "present", value: "" }])} disabled={pending}>
                + parameter
              </Button>
            </div>
            {queryRows.length === 0 ? <p className="mt-1 text-xs text-muted">None. E.g. utm_source equals tiktok, or gclid present.</p> : null}
            <div className="mt-1 flex flex-col gap-2">
              {queryRows.map((row, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_1fr_auto] gap-2">
                  <input
                    name="query_key"
                    value={row.key}
                    onChange={(e) => setQueryRows(queryRows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    placeholder="utm_source"
                    className={`${INPUT_CLASS} h-9 font-mono`}
                    disabled={pending}
                  />
                  <select
                    name="query_mode"
                    value={row.mode}
                    onChange={(e) => setQueryRows(queryRows.map((r, j) => (j === i ? { ...r, mode: e.target.value as QueryRuleRow["mode"] } : r)))}
                    className={`${SELECT_CLASS} h-9`}
                    disabled={pending}
                  >
                    {QUERY_MODES.map((m) => (
                      <option key={m} value={m}>
                        {QUERY_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                  <input
                    name="query_value"
                    value={row.value}
                    onChange={(e) => setQueryRows(queryRows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    placeholder={row.mode === "equals" ? "value" : "—"}
                    className={`${INPUT_CLASS} h-9`}
                    disabled={pending || row.mode !== "equals"}
                  />
                  <Button size="sm" variant="ghost" onClick={() => setQueryRows(queryRows.filter((_, j) => j !== i))} disabled={pending}>
                    ×
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {routeAction === "BLOCK" ? (
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input type="checkbox" name="bot" defaultChecked={initialConditions.bot} className={CHECKBOX_CLASS} disabled={pending} />
              Bots and crawlers only (by User-Agent). Use it to stop scrapers; it doesn&apos;t change the content served.
            </label>
          ) : null}
        </div>
      </fieldset>

      {state.error ? (
        <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : route ? "Save route" : "Create route"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
