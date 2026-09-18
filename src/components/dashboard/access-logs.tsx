import { ConversionsIcon } from "@/components/icons";

/**
 * "Access Logs" em estado de espera. Sem logging de requests, não há atividade
 * para listar; mostra a moldura e um estado vazio honesto.
 */
export function AccessLogs() {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">Access Logs</h2>
      <p className="mt-0.5 text-sm text-muted">Real-time request activity</p>

      <div className="mt-5 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-foreground/5 text-muted">
          <ConversionsIcon className="size-5" />
        </span>
        <p className="text-sm font-medium">No activity yet</p>
        <p className="max-w-sm text-xs text-muted">
          Live request logs will appear here when tracking is enabled on the delivery server.
        </p>
      </div>
    </section>
  );
}
