"use client";

import { useActionState } from "react";
import { signIn } from "@/lib/auth/actions";
import { INITIAL_LOGIN_STATE } from "@/lib/auth/login-state";

/**
 * Um campo, e o campo é uma senha.
 *
 * `action={fn}` e NÃO `onSubmit`: com uma função em `action`, o React
 * renderiza `method="post"` já no HTML do servidor. Um `<form>` sem method
 * envia por GET, e um Enter antes da hidratação mandaria a senha para a barra
 * de endereço como `?password=…`. Não acrescente `method` nem `onSubmit`.
 *
 * O campo é não controlado: quem guarda a senha é o navegador, e ela é lida
 * uma vez, do FormData, no servidor. `key={state.attempt}` remonta o campo
 * depois de cada falha, e remontar esvazia.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signIn, INITIAL_LOGIN_STATE);

  return (
    <form action={action} className="mt-5 flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Senha</span>
        <input
          key={state.attempt}
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          required
          disabled={pending}
          className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-accent"
        />
      </label>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error === "blocked"
            ? "Muitas tentativas. Aguarde 15 minutos e tente de novo."
            : "Senha incorreta."}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-1 h-10 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
