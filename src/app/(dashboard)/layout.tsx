import { Sidebar } from "@/components/sidebar";

/**
 * Todas as telas do painel leem o banco a cada request. Sem isto o Next
 * tentaria pré-renderizar `/`, `/dominios` e `/paginas` no build: bateria no
 * Supabase em tempo de build (falha sem env) e congelaria dados no HTML.
 */
export const dynamic = "force-dynamic";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar />
      <main className="flex-1 px-4 py-8 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
