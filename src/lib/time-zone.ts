/**
 * Frontend display time zone. The database stores and returns instants in UTC
 * (`timestamptz`, session in UTC) and never converts time zones; converting to
 * this zone happens only in the frontend, when displaying or grouping by day.
 *
 * Every `Intl.DateTimeFormat`/`toLocale*` that shows a date or time passes
 * `timeZone: APP_TZ` — otherwise SSR uses the server's zone and the client the
 * browser's, and the same time shows up differently in each place.
 */
export const APP_TZ = "America/New_York";

/** The zone's offset at the given instant, in ms (local time = UTC + offset; NY gives -4h or -5h). */
function offsetMs(ms: number, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName")?.value; // "GMT-04:00" (or "GMT" in UTC)
  const m = name?.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}

/** Local date ("2026-09-23") of the instant, in the zone. */
export function localDateKey(ms: number, tz: string = APP_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * Local midnight `daysAgo` days before the day of `nowMs`, in UTC ms.
 * With daylight saving a local day has 23 or 25 hours, so "N days ago"
 * is not `- N * 24h`: the offset is that day's midnight offset, not today's.
 */
export function localMidnight(nowMs: number, daysAgo = 0, tz: string = APP_TZ): number {
  const [y, mo, d] = localDateKey(nowMs, tz).split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d - daysAgo); // Date.UTC normalizes day 0/negative into the previous month
  // The 1st pass finds an instant near midnight; the 2nd uses its offset (NY switches at 2am, never at midnight).
  return wall - offsetMs(wall - offsetMs(wall, tz), tz);
}
