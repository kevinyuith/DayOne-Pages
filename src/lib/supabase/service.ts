import { createClient } from "@supabase/supabase-js";

/**
 * O client de serviço — o ÚNICO client Supabase deste projeto.
 *
 * Não há login no Supabase: a porta do dashboard é uma senha única e um cookie
 * assinado (src/lib/auth). Logo não existe sessão de usuário para carregar, e
 * todas as leituras e escritas passam por aqui, com a chave de serviço.
 *
 * A chave de serviço tem BYPASSRLS. Isso significa, sem meias palavras: a RLS
 * do schema `pages` não protege nada do que este módulo faz. A defesa é (a) o
 * cookie de sessão conferido no proxy e no layout e (b) `requireSession()`
 * dentro de cada action antes de qualquer escrita.
 *
 * Três guardas mantêm a chave fora do navegador:
 *   1. `SUPABASE_SERVICE_KEY` não tem prefixo NEXT_PUBLIC_ — o Next não a
 *      substitui no pacote do cliente.
 *   2. A guarda `typeof window` abaixo derruba na hora se este módulo for
 *      parar num pacote de cliente.
 *   3. `npm run check:secrets` procura o valor em `.next/static/` depois do
 *      build. É a única das três que é prova, não intenção.
 *
 * Sem cache de módulo: uma instância por chamada. Client guardado entre
 * requisições serviria o estado de um pedido para outro.
 */

if (typeof window !== "undefined") {
  throw new Error("src/lib/supabase/service.ts foi importado no navegador. Este módulo é do servidor.");
}

export const SERVICE_KEY_VAR = "SUPABASE_SERVICE_KEY";

/** Configurado? Booleano, nunca o valor. */
export function serviceConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env[SERVICE_KEY_VAR]);
}

/** Um client novo, preso ao schema `pages`, com a chave de serviço. */
export function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env[SERVICE_KEY_VAR];

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL ausente.");
  if (!key) throw new Error(`${SERVICE_KEY_VAR} ausente.`);

  return createClient(url, key, {
    db: { schema: "pages" },
    // Não há usuário nesta conexão, há uma chave: nada a persistir nem renovar.
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
