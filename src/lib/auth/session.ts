import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, isValidSession } from "./cookie";
import { LOGIN_PATH } from "./routes";

/**
 * A sessão, do ponto de vista de um Server Component ou de uma action.
 *
 * Não há usuário: a porta é uma senha única e o sistema não pretende saber
 * quem está do outro lado. Por isso estas funções não devolvem identidade.
 *
 * Esta é a SEGUNDA tranca. A primeira é `src/proxy.ts`, que roda antes da
 * renderização e preserva a rota pretendida no `?next=`. A segunda existe
 * porque o proxy depende de um `matcher` — uma lista de exclusão — e lista de
 * exclusão é o tipo de coisa que ganha um padrão a mais num dia distraído.
 * E porque server action é POST que chega sem passar pela tela: cada action
 * chama `requireSession()` antes de escrever.
 */

export async function hasSession(): Promise<boolean> {
  const store = await cookies();
  return isValidSession(store.get(SESSION_COOKIE)?.value);
}

/** Exige sessão, ou desvia para o login. */
export async function requireSession(): Promise<void> {
  if (await hasSession()) return;
  redirect(LOGIN_PATH);
}
