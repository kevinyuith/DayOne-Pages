"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_OPTIONS, SESSION_COOKIE, SESSION_SECRET_VAR, SESSION_TTL_MS, isSecureRequest, issueSession, secretConfigured } from "./cookie";
import type { LoginState } from "./login-state";
import { canAttempt, recordFailure, requestIp } from "./rate-limit";
import { HOME_PATH, LOGIN_PATH, safeNextPath } from "./routes";
import { verifyPassword } from "./password";

/**
 * Entrar e sair — as duas únicas ações da porta.
 *
 * Ação de servidor, e não rota em /api, porque o proxy devolve 401 em toda
 * rota `/api/*` sem cookie — e uma rota de login lá precisaria ser aberta
 * como exceção. A ação chega como POST na própria `/login`, que já é pública.
 *
 * A senha viaja no corpo do POST e morre aqui: não é gravada, nem logada, nem
 * vai para o cookie.
 *
 * A ordem das perguntas:
 *   1. este IP ainda pode tentar?     — antes de gastar 300 ms de scrypt
 *   2. a senha confere?               — tempo constante
 *   3. registra a falha, se falhou
 *   4. há como assinar a sessão?      — depois do scrypt, para o relógio não contar configuração
 */
export async function signIn(previous: LoginState, formData: FormData): Promise<LoginState> {
  const attempt = previous.attempt + 1;

  const rawPassword = formData.get("password");
  const password = typeof rawPassword === "string" ? rawPassword : "";
  const rawNext = formData.get("next");
  const next = typeof rawNext === "string" ? rawNext : HOME_PATH;

  const requestHeaders = await headers();
  const ip = requestIp(requestHeaders);

  const limit = await canAttempt(ip);
  if (!limit.allowed) return { error: "blocked", attempt };

  const ok = await verifyPassword(password);
  if (!ok) {
    await recordFailure(ip);
    // Uma mensagem para tudo: senha errada, hash ausente, hash malformado.
    return { error: "credentials", attempt };
  }

  if (!secretConfigured()) {
    console.error(
      `[acesso] senha correta, mas ${SESSION_SECRET_VAR} está ausente ou curta demais (mínimo 16 caracteres). ` +
        "Nenhuma sessão pode ser emitida.",
    );
    return { error: "credentials", attempt };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, issueSession(), {
    ...COOKIE_OPTIONS,
    secure: isSecureRequest(requestHeaders),
    // Cortesia de limpeza para o navegador; a tranca é o `exp` assinado.
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  redirect(safeNextPath(next) ?? HOME_PATH);
}

/** Sair. Ação de servidor porque o cookie é httpOnly e o JavaScript da página não o enxerga. */
export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect(LOGIN_PATH);
}
