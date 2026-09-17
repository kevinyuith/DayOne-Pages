/**
 * As rotas que a autenticação precisa saber de cor.
 *
 * Sem dependência nenhuma de propósito: este módulo é importado pelo
 * `src/proxy.ts`, que roda fora do React.
 */

/** A tela de login. Única rota pública do dashboard. */
export const LOGIN_PATH = "/login";

/** Para onde vai quem entrou sem ter pedido uma rota específica. */
export const HOME_PATH = "/";

/** Parâmetro que guarda a rota pretendida durante o desvio para o login. */
export const NEXT_PARAM = "next";

/**
 * Só caminho interno vira destino de volta.
 *
 * Sem esta trava, `?next=https://outro.site` transformaria o login num
 * redirecionador aberto. `//` e `/\` são recusados porque o navegador os lê
 * como URL absoluta com o protocolo atual.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value === LOGIN_PATH || value.startsWith(`${LOGIN_PATH}?`)) return null;
  return value;
}
