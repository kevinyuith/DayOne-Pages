/**
 * O resultado de toda server action deste projeto.
 *
 * Em vez de lançar: uma exceção numa action vira um erro genérico na tela e
 * um stack trace no log, e quem está do outro lado não sabe o que corrigir.
 * `{ ok: false, reason }` carrega uma frase que a tela pode mostrar como está.
 */
export type ActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; reason: string };

export function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export function errorReason(cause: unknown, fallback = "Erro inesperado."): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
