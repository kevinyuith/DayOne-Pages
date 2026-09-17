import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { domainsUsingPage, getPageWithSlugs, getSlug } from "@/lib/pages/queries";
import { PageEditor } from "./page-editor";

type Params = Promise<{ id: string; slugId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const page = await getPageWithSlugs(id);
  return { title: page ? `Editar: ${page.name}` : "Página" };
}

export default async function SlugEditorPage({ params }: { params: Params }) {
  const { id, slugId } = await params;
  const [page, slug, domains] = await Promise.all([getPageWithSlugs(id), getSlug(slugId), domainsUsingPage(id)]);
  if (!page || !slug || slug.page_id !== page.id) notFound();

  return <PageEditor page={page} slugs={page.slugs} slug={slug} domains={domains} />;
}
