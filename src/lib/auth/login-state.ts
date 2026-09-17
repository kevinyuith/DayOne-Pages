/**
 * O estado do formulário de login, fora do arquivo `'use server'`.
 *
 * Um arquivo `'use server'` só pode exportar funções assíncronas: cada export
 * vira um ponto de entrada invocável pelo navegador, e uma constante não é
 * invocável. O Next recusa o módulo inteiro na avaliação.
 */
export type LoginState = {
  error?: "credentials" | "blocked";
  /** Cresce a cada envio; a tela usa como `key` para remontar (e esvaziar) o campo. */
  attempt: number;
};

export const INITIAL_LOGIN_STATE: LoginState = { attempt: 0 };
