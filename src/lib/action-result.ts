/**
 * The result of every server action in this project.
 *
 * Instead of throwing: an exception in an action becomes a generic error on the
 * screen and a stack trace in the log, and whoever is on the other side can't
 * tell what to fix. `{ ok: false, reason }` carries a sentence the screen can
 * show as is.
 */
export type ActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; reason: string };

export function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export function errorReason(cause: unknown, fallback = "Unexpected error."): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
