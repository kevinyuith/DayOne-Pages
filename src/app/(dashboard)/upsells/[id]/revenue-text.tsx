import { fmtMoney, fmtPerVisit } from "./metrics";

/**
 * Revenue as the exact number (sales tied by the order), with the estimated part
 * (tied only by the same IP within 6 h) apart under it: "+ $X estimated".
 */
export function RevenueText({ exact, estimated, inline = false }: { exact: number; estimated: number; inline?: boolean }) {
  if (estimated <= 0) return <>{fmtMoney(exact)}</>;
  return (
    <span className={inline ? "" : "flex flex-col leading-tight"}>
      <span>{fmtMoney(exact)}</span>
      <span className="text-xs font-normal text-muted"> + {fmtMoney(estimated)} estimated</span>
    </span>
  );
}

/** Revenue per visit (or buyer): the exact part, with the estimated part apart. */
export function PerVisitText({ exact, estimated, visits }: { exact: number; estimated: number; visits: number }) {
  if (estimated <= 0 || visits <= 0) return <>{fmtPerVisit(exact, visits)}</>;
  return (
    <span className="flex flex-col leading-tight">
      <span>{fmtPerVisit(exact, visits)}</span>
      <span className="text-xs font-normal text-muted">+ {fmtPerVisit(estimated, visits)} est.</span>
    </span>
  );
}
