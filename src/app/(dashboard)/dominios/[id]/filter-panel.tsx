"use client";

import { useActionState, useState } from "react";
import { RowAction } from "@/components/row-action";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CHECKBOX_CLASS, Field, INPUT_CLASS, SELECT_BASE, SELECT_CLASS } from "@/components/ui/field";
import {
  DEVICES,
  DEVICE_LABELS,
  LIST_MODES,
  LIST_MODE_LABELS,
  QUERY_MODES,
  QUERY_MODE_LABELS,
  conditionsToForm,
  summarizeConditions,
  type ListMode,
  type QueryRuleRow,
} from "@/lib/pages/conditions";
import type { DomainDetail, PageOption } from "@/lib/pages/queries";
import { PAGE_KIND_LABELS, PAGE_STATUS_LABELS } from "@/lib/pages/types";
import { clearFilter, saveFilter, type FilterFormState } from "../actions";

/**
 * O filtro do domínio: uma condição, uma página para quem passa, outra para
 * quem não passa. As dimensões são país, idioma, dispositivo, parâmetros de URL
 * e referrer — as mesmas das rotas, sem `bot` (bot só bloqueia, e isso é o
 * interruptor de bots do domínio, não o filtro). País e idioma têm modo
 * permitir-só/bloquear. As regras manuais, quando existem, têm prioridade.
 */
export function FilterPanel({ domain, pages }: { domain: DomainDetail; pages: PageOption[] }) {
  const active = domain.filter != null && domain.filter_pass_page_id != null;
  const [editing, setEditing] = useState(false);

  if (active && !editing) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Domain filter</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <RowAction action={clearFilter.bind(null, domain.id)} label="Remove filter" variant="danger" confirm="Remove this domain's filter?" />
          </div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <span className="text-xs font-medium text-muted">Condition</span>
          <span className="text-sm">{summarizeConditions(domain.filter)}</span>
          <span className="text-xs font-medium text-muted">Passes →</span>
          <PageLine page={domain.filter_pass_page} />
          <span className="text-xs font-medium text-muted">Fails →</span>
          <PageLine page={domain.filter_fail_page} />
        </div>
        <p className="mt-3 text-xs text-muted">The routes below, if any, are evaluated before the filter.</p>
      </section>
    );
  }

  return <FilterForm domain={domain} pages={pages} onDone={() => setEditing(false)} showCancel={active} />;
}

function PageLine({ page }: { page: DomainDetail["filter_pass_page"] }) {
  if (!page) return <span className="text-sm text-muted">page removed</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-sm">
      {page.name}
      <span className="text-xs text-muted">{PAGE_KIND_LABELS[page.kind]}</span>
      {page.status !== "PUBLISHED" ? <Badge tone="warning">not published</Badge> : null}
    </span>
  );
}

const INITIAL: FilterFormState = { attempt: 0 };

function FilterForm({
  domain,
  pages,
  onDone,
  showCancel,
}: {
  domain: DomainDetail;
  pages: PageOption[];
  onDone: () => void;
  showCancel: boolean;
}) {
  const initial = conditionsToForm(domain.filter);
  const [state, action, pending] = useActionState(saveFilter, INITIAL);
  const [queryRows, setQueryRows] = useState<QueryRuleRow[]>(initial.query);

  if (state.success) {
    // Salvou: o servidor revalidou a página; volta para a visão de leitura.
    queueMicrotask(onDone);
  }

  return (
    <form action={action} className="rounded-xl border border-accent/30 bg-surface p-5">
      <input type="hidden" name="domain_id" value={domain.id} />
      <h2 className="text-base font-semibold">Domain filter</h2>
      <p className="mt-1 text-xs text-muted">
        Visitors who pass ALL conditions see one page; those who don&apos;t see the other. With no condition, everyone passes.
      </p>

      <fieldset className="mt-4">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Conditions</legend>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <ListModeField
            label="Countries (ISO-2, comma-separated)"
            name="countries"
            modeName="countries_mode"
            defaultMode={initial.countriesMode}
            defaultValue={initial.countries}
            placeholder="BR, PT"
            hint="From Cloudflare's CF-IPCountry header"
            upper
            disabled={pending}
          />
          <ListModeField
            label="Languages (ISO 639-1, comma-separated)"
            name="languages"
            modeName="languages_mode"
            defaultMode={initial.languagesMode}
            defaultValue={initial.languages}
            placeholder="en, es"
            hint="From the browser's Accept-Language header"
            disabled={pending}
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Devices</span>
            <div className="flex h-10 items-center gap-4">
              {DEVICES.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="devices" value={d} defaultChecked={initial.devices.includes(d)} className={CHECKBOX_CLASS} disabled={pending} />
                  {DEVICE_LABELS[d]}
                </label>
              ))}
            </div>
          </div>
          <Field label="Referrer contains" className="md:col-span-2">
            <input name="referrer" defaultValue={initial.referrer} placeholder="facebook.com" className={INPUT_CLASS} disabled={pending} />
          </Field>
          <div className="md:col-span-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted">URL parameters</span>
              <Button size="sm" variant="ghost" onClick={() => setQueryRows([...queryRows, { key: "", mode: "present", value: "" }])} disabled={pending}>
                + parameter
              </Button>
            </div>
            {queryRows.length === 0 ? <p className="mt-1 text-xs text-muted">E.g. gclid present, or utm_source equals facebook.</p> : null}
            <div className="mt-1 flex flex-col gap-2">
              {queryRows.map((row, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_1fr_auto] gap-2">
                  <input
                    name="query_key"
                    value={row.key}
                    onChange={(e) => setQueryRows(queryRows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    placeholder="gclid"
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
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Pages</legend>
        <p className="mt-1 text-xs text-muted">Only this domain&apos;s pages. To use another template, copy it first under Domain pages.</p>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <Field label="Visitors who PASS the filter see">
            <PageSelect name="filter_pass_page_id" pages={pages} value={domain.filter_pass_page_id} disabled={pending} />
          </Field>
          <Field label="Visitors who DON'T pass see">
            <PageSelect name="filter_fail_page_id" pages={pages} value={domain.filter_fail_page_id} disabled={pending} />
          </Field>
        </div>
      </fieldset>

      {state.error ? (
        <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.success ? <Alert tone="success" className="mt-4">{state.success}</Alert> : null}

      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save filter"}
        </Button>
        {showCancel ? (
          <Button variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Uma lista (país/idioma) com o seletor de sentido: permitir só os listados, ou bloqueá-los. */
function ListModeField({
  label,
  name,
  modeName,
  defaultMode,
  defaultValue,
  placeholder,
  hint,
  upper = false,
  disabled,
}: {
  label: string;
  name: string;
  modeName: string;
  defaultMode: ListMode;
  defaultValue: string;
  placeholder: string;
  hint: string;
  upper?: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="flex gap-2">
        <select name={modeName} defaultValue={defaultMode} className={`${SELECT_BASE} w-32 shrink-0`} disabled={disabled}>
          {LIST_MODES.map((m) => (
            <option key={m} value={m}>
              {LIST_MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <input name={name} defaultValue={defaultValue} placeholder={placeholder} className={`${INPUT_CLASS} ${upper ? "uppercase" : ""}`} disabled={disabled} />
      </div>
      <span className="text-xs text-muted">{hint}</span>
    </div>
  );
}

function PageSelect({ name, pages, value, disabled }: { name: string; pages: PageOption[]; value: string | null; disabled: boolean }) {
  return (
    <select name={name} defaultValue={value ?? ""} className={SELECT_CLASS} disabled={disabled}>
      <option value="">— choose —</option>
      {pages.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} · {PAGE_KIND_LABELS[p.kind]}
          {p.status !== "PUBLISHED" ? ` (${PAGE_STATUS_LABELS[p.status].toLowerCase()})` : ""}
        </option>
      ))}
    </select>
  );
}
