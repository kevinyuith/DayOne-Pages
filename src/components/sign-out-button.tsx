import { signOut } from "@/lib/auth/actions";

/**
 * Server Component: o `<form action>` chama a action direto, sem JavaScript.
 * É passado à Sidebar (client) como ReactNode.
 */
export function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        Sair
      </button>
    </form>
  );
}
