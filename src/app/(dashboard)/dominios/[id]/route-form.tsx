"use client";

import { useActionState, useEffect, useState } from "react";
import { RuleRows } from "@/components/rule-rows";
import { Button } from "@/components/ui/button";
import { CHECKBOX_CLASS, Field, INPUT_CLASS, SELECT_CLASS } from "@/components/ui/field";
import { DEVICES, DEVICE_LABELS, conditionsToForm, type RuleRow } from "@/lib/pages/conditions";
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
 * resto é FormData puro lido por `saveRoute`. As linhas de parâmetro de URL e
 * de cookie são listas paralelas (`query_*`, `cookie_*`), ver `RuleRows`.
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
  const [queryRows, setQueryRows] = useState<RuleRow[]>(initialConditions.query);
  const [cookieRows, setCookieRows] = useState<RuleRow[]>(initialConditions.cookies);

  useEffect(() => {
    if (state.savedId) onDone();
  }, [state.savedId, onDone]);

  const selectedPage = pages.find((p) => p.id === pageId);

  return (
    <form action={action} className="rounded-xl border border-accent/30 bg-surface p-5">
      <input type="hidden" name="domain_id" value={domainId} />
      {route ? <input type="hidden" name="route_id" value={route.id} /> : null}

      <h3 className="text-sm font-semibold">{route ? "Editar rota" : "Nova rota"}</h3>

      <div className="mt-4 grid gap-4 md:grid-cols-4">
        <Field label="Nome (opcional)" className="md:col-span-2">
          <input name="name" defaultValue={route?.name ?? ""} placeholder="Ex.: promo de setembro" className={INPUT_CLASS} disabled={pending} />
        </Field>
        <Field label="Prioridade" hint="Menor = avaliada antes">
          <input name="priority" type="number" min={0} max={100000} defaultValue={nextPriority} required className={INPUT_CLASS} disabled={pending} />
        </Field>
        {/* Alinha com o INPUT de Prioridade (label + gap = 20px), não com a dica abaixo dele. */}
        <label className="flex h-10 items-center gap-2 self-start text-sm md:mt-5">
          <input type="checkbox" name="is_active" defaultChecked={route?.is_active ?? true} className={CHECKBOX_CLASS} disabled={pending} />
          Ativa
        </label>
      </div>

      <fieldset className="mt-5">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Path</legend>
        <div className="mt-2 grid gap-4 md:grid-cols-4">
          <Field label="Casamento">
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
              label={matchType === "REGEX" ? "Expressão (POSIX, contra o path canônico)" : "Path"}
              hint={matchType === "PREFIX" ? "Casa o path e tudo abaixo dele (/br casa /br e /br/x)" : undefined}
              className="md:col-span-3"
            >
              <input
                name="path_pattern"
                defaultValue={route?.path_pattern ?? ""}
                placeholder={matchType === "REGEX" ? "^/(promo|oferta)(/|$)" : "/promo"}
                className={`${INPUT_CLASS} font-mono`}
                disabled={pending}
              />
            </Field>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Ação</legend>
        <div className="mt-2 grid gap-4 md:grid-cols-4">
          <Field label="O que fazer">
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
              <Field label="Página" className="md:col-span-2">
                <select name="page_id" value={pageId} onChange={(e) => setPageId(e.target.value)} className={SELECT_CLASS} disabled={pending}>
                  {pages.length === 0 ? <option value="">— crie uma página antes —</option> : null}
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {PAGE_KIND_LABELS[p.kind]}
                      {p.status !== "PUBLISHED" ? ` (${PAGE_STATUS_LABELS[p.status].toLowerCase()})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Slug da página" hint="Vazio = usa o path da request como slug">
                <select name="slug" defaultValue={route?.slug ?? ""} className={`${SELECT_CLASS} font-mono`} disabled={pending}>
                  <option value="">(path da request)</option>
                  {(selectedPage?.slugs ?? []).map((s) => (
                    <option key={s.id} value={s.slug}>
                      {s.slug}
                      {s.is_active ? "" : " (inativa)"}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : null}

          {routeAction === "REDIRECT" ? (
            <>
              <Field label="URL de destino" className="md:col-span-2">
                <input name="redirect_url" defaultValue={route?.redirect_url ?? ""} placeholder="https://destino.com/x" className={INPUT_CLASS} disabled={pending} />
              </Field>
              <Field label="Código">
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
                Manter a query string original (utm, gclid…)
              </label>
            </>
          ) : null}

          {routeAction === "BLOCK" ? (
            <Field label="Código">
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
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Condições (todas precisam casar; vazio = sempre)</legend>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <Field label="Países (ISO-2, separados por vírgula)" hint="Vem do header CF-IPCountry do Cloudflare">
            <input name="countries" defaultValue={initialConditions.countries} placeholder="BR, PT, US" className={`${INPUT_CLASS} uppercase`} disabled={pending} />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Dispositivos</span>
            <div className="flex h-10 items-center gap-4">
              {DEVICES.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="devices" value={d} defaultChecked={initialConditions.devices.includes(d)} className={CHECKBOX_CLASS} disabled={pending} />
                  {DEVICE_LABELS[d]}
                </label>
              ))}
            </div>
          </div>
          <Field label="Referrer contém" className="md:col-span-2">
            <input name="referrer" defaultValue={initialConditions.referrer} placeholder="facebook.com" className={INPUT_CLASS} disabled={pending} />
          </Field>

          <RuleRows
            prefix="query"
            title="Parâmetros de URL"
            addLabel="+ parâmetro"
            emptyHint="Nenhum. Ex.: utm_source igual a tiktok, ou gclid presente."
            keyPlaceholder="utm_source"
            rows={queryRows}
            onChange={setQueryRows}
            disabled={pending}
          />
          <RuleRows
            prefix="cookie"
            title="Cookies"
            addLabel="+ cookie"
            emptyHint="Nenhum. Ex.: dop_step igual a p_ab12 (etapa do funil em modo servidor), ou vip presente."
            keyPlaceholder="dop_step"
            rows={cookieRows}
            onChange={setCookieRows}
            disabled={pending}
          />

          {routeAction === "BLOCK" ? (
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input type="checkbox" name="bot" defaultChecked={initialConditions.bot} className={CHECKBOX_CLASS} disabled={pending} />
              Só bots e crawlers (pelo User-Agent). Serve para barrar scrapers; não altera o conteúdo servido.
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
          {pending ? "Salvando…" : route ? "Salvar rota" : "Criar rota"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
