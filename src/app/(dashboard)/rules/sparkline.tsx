import { APP_TZ } from "@/lib/time-zone";

const W = 120;
const H = 28;
const PAD = 3;

const num = new Intl.NumberFormat("en-US");
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, month: "short", day: "numeric" });

/**
 * A rule's last days as a line (one point per New York day, today last), drawn
 * on the server. Spike days get a red dot; each day's count shows on hover
 * (the day's <title>).
 */
export function Sparkline({ values, starts, spikes }: { values: number[]; starts: number[]; spikes: Set<number> }) {
  const max = Math.max(0, ...values);
  const step = values.length > 1 ? (W - 2 * PAD) / (values.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  const y = (v: number) => (max > 0 ? H - PAD - (v / max) * (H - 2 * PAD) : H - PAD);
  const peak = values.indexOf(max);
  const label = max > 0 ? `Peak ${num.format(max)} on ${dayFmt.format(starts[peak])}` : `None in ${values.length} days`;

  return (
    <svg role="img" aria-label={label} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block overflow-visible text-foreground/55">
      <polyline
        points={values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {values.map((v, i) =>
        spikes.has(i) ? <circle key={`s${i}`} cx={x(i)} cy={y(v)} r={2.75} className="fill-red-600 stroke-surface dark:fill-red-500" strokeWidth={1.5} /> : null,
      )}
      {values.map((v, i) => (
        <rect key={i} x={x(i) - step / 2} y={0} width={Math.max(step, 1)} height={H} fill="transparent">
          <title>{`${dayFmt.format(starts[i])}: ${num.format(v)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** The trend of every rule: the days' starts, and per rule its counts and which of those days were spikes. */
export type Trends = { starts: number[]; byRule: Map<string, { values: number[]; spikes: Set<number> }> };

/** A rule's sparkline; a rule with no clicks in the days gets a flat line. */
export function TrendCell({ trends, id }: { trends: Trends; id: string }) {
  const t = trends.byRule.get(id);
  return <Sparkline values={t?.values ?? trends.starts.map(() => 0)} starts={trends.starts} spikes={t?.spikes ?? new Set()} />;
}
