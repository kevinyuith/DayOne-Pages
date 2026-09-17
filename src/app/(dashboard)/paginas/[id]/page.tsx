import { notFound, redirect } from "next/navigation";
import { getPageWithSlugs } from "@/lib/pages/queries";

/** A página em si não tem tela: o editor é por slug. Vai para a raiz (`/`) ou para a primeira. */
export default async function PaginaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await getPageWithSlugs(id);
  if (!page) notFound();

  const root = page.slugs.find((s) => s.slug === "/") ?? page.slugs[0];
  if (!root) notFound();

  redirect(`/paginas/${page.id}/slugs/${root.id}`);
}
