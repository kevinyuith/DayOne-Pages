import type { Metadata } from "next";
import { HOME_PATH, NEXT_PARAM, safeNextPath } from "@/lib/auth/routes";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Entrar",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params[NEXT_PARAM];
  const next = safeNextPath(typeof raw === "string" ? raw : null) ?? HOME_PATH;

  return (
    <>
      <div className="flex items-center gap-2 font-semibold tracking-tight">
        <span className="flex size-7 items-center justify-center rounded-md bg-accent text-sm text-accent-foreground">D</span>
        DayOne Pages
      </div>
      <h1 className="mt-5 text-base font-semibold">Entrar</h1>
      <p className="mt-1 text-sm text-muted">Digite a senha de acesso do painel.</p>
      <LoginForm next={next} />
    </>
  );
}
