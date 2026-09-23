/**
 * Fuso de exibição do frontend. O banco guarda e devolve instantes em UTC
 * (`timestamptz`, sessão em UTC) e não converte fuso; a conversão para este
 * fuso acontece só no frontend, na hora de mostrar ou de agrupar por dia.
 *
 * Todo `Intl.DateTimeFormat`/`toLocale*` que mostra data ou hora passa
 * `timeZone: APP_TZ` — senão o SSR usa o fuso do servidor e o client o do
 * navegador, e a mesma hora aparece diferente em cada lugar.
 */
export const APP_TZ = "America/New_York";

/** Offset do fuso no instante dado, em ms (hora local = UTC + offset; NY dá -4h ou -5h). */
function offsetMs(ms: number, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName")?.value; // "GMT-04:00" (ou "GMT" em UTC)
  const m = name?.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}

/** Data local ("2026-09-23") do instante, no fuso. */
export function localDateKey(ms: number, tz: string = APP_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * Meia-noite local de `daysAgo` dias antes do dia de `nowMs`, em ms UTC.
 * Com horário de verão um dia local tem 23 ou 25 horas, então "N dias atrás"
 * não é `- N * 24h`: o offset é o da meia-noite daquele dia, não o de agora.
 */
export function localMidnight(nowMs: number, daysAgo = 0, tz: string = APP_TZ): number {
  const [y, mo, d] = localDateKey(nowMs, tz).split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d - daysAgo); // Date.UTC normaliza dia 0/negativo para o mês anterior
  // 1ª passada acha um instante perto da meia-noite; a 2ª usa o offset dele (a troca de NY é às 2h, nunca à meia-noite).
  return wall - offsetMs(wall - offsetMs(wall, tz), tz);
}
