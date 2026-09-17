import { Sidebar } from "@/components/sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { requireSession } from "@/lib/auth/session";

/**
 * A segunda tranca: o proxy já desviou quem não tem cookie, mas o `matcher`
 * dele é uma lista de exclusão. Aqui a sessão é conferida de novo, antes de
 * qualquer leitura do banco.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireSession();

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar footer={<SignOutButton />} />
      <main className="flex-1 px-4 py-8 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
