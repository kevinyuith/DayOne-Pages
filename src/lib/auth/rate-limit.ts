import { supabaseService } from "@/lib/supabase/service";

/**
 * Limite de tentativas de login — no banco, porque em memória não serviria.
 *
 * Contador em memória conta por processo (várias instâncias = várias
 * contagens) e zera a cada deploy. Estado que precisa sobreviver a processo
 * mora no banco: `pages.access_attempts`. Só falhas entram; nunca a senha.
 *
 * Degrada, nunca quebra: se a tabela não existir ou o banco falhar, a porta
 * segue SEM limite e avisa no log uma vez por processo. O contrário — falhar
 * fechado — transformaria qualquer soluço do banco numa tranca total.
 *
 * O scrypt custa centenas de milissegundos de propósito; por isso o limite
 * é conferido ANTES dele. Sem esse corte, derrubar o servidor não exigiria
 * adivinhar senha nenhuma: bastaria pedir mil verificações por segundo.
 */

export const FAILURES_TO_BLOCK = 5;
export const WINDOW_MINUTES = 15;

const TABLE = "access_attempts";

let warned = false;
function warnOnce(why: string) {
  if (warned) return;
  warned = true;
  console.warn(`[acesso] contador de tentativas indisponível — seguindo SEM limite. Motivo: ${why}`);
}

/**
 * De qual IP veio a requisição?
 *
 * `x-forwarded-for` é uma lista e quem manda a requisição pode inventar o
 * começo dela. O ÚLTIMO elo foi escrito pelo proxy mais próximo de nós, que é
 * o único que não é o cliente. Vale enquanto houver um proxy à frente; com
 * um CDN na frente do host, reconferir.
 */
export function requestIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return headers.get("x-real-ip")?.trim() || "desconhecido";
}

export type LimitState = {
  /** Pode tentar? `true` também quando o contador está indisponível. */
  allowed: boolean;
  /** O contador respondeu? `false` = estamos sem limite. */
  counting: boolean;
};

/**
 * A decisão, separada da chamada, para poder ser provada sem banco.
 * `count` nulo é cegueira, não zero: é o que uma tabela ausente devolve
 * (status 204, sem erro).
 */
export function interpretCount(count: number | null | undefined, error: string | null): { state: LimitState; warning: string | null } {
  if (error) return { state: { allowed: true, counting: false }, warning: error };
  if (typeof count !== "number") {
    return { state: { allowed: true, counting: false }, warning: `consulta sem erro e sem contagem (count=${String(count)})` };
  }
  return { state: { allowed: count < FAILURES_TO_BLOCK, counting: true }, warning: null };
}

export async function canAttempt(ip: string): Promise<LimitState> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  try {
    const { count, error } = await supabaseService()
      .from(TABLE)
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .gte("occurred_at", since);
    const { state, warning } = interpretCount(count, error?.message ?? null);
    if (warning) warnOnce(warning);
    return state;
  } catch (cause) {
    warnOnce(cause instanceof Error ? cause.message : "erro desconhecido");
    return { allowed: true, counting: false };
  }
}

/** Registra uma falha. Não lança: perder um registro é uma tentativa a mais permitida; lançar seria um 500 no login. */
export async function recordFailure(ip: string): Promise<void> {
  try {
    const { error } = await supabaseService().from(TABLE).insert({ ip });
    if (error) warnOnce(error.message);
  } catch (cause) {
    warnOnce(cause instanceof Error ? cause.message : "erro desconhecido");
  }
}
