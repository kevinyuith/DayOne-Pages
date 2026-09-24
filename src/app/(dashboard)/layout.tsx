import { cookies } from "next/headers";
import { Sidebar } from "@/components/sidebar";
import { SIDEBAR_COOKIE } from "@/lib/navigation";

/**
 * Every dashboard screen reads the database on each request. Without this, Next
 * would try to prerender `/`, `/domains` and `/templates` at build: it would hit
 * Supabase at build time (failing without env) and freeze data into the HTML.
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
