import { cookies } from "next/headers";
import { Sidebar } from "@/components/sidebar";
import { SIDEBAR_COOKIE } from "@/lib/navigation";

/**
 * Todas as telas do painel leem o banco a cada request. Sem isto o Next
 * tentaria pré-renderizar `/`, `/dominios` e `/paginas` no build: bateria no
 * Supabase em tempo de build (falha sem env) e congelaria dados no HTML.
 */
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value !== "expanded";

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar defaultCollapsed={collapsed} />
      <main className="min-w-0 flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
