import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPageWithSlugs, getSlug } from "@/lib/pages/queries";
import { createSlug, deletePage, deleteSlug, renameSlug, saveEditor, toggleSlug } from "../../../actions";
import { PageEditor } from "./page-editor";

type Params = Promise<{ id: string; slugId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const page = await getPageWithSlugs(id);
  return { title: page ? `Edit: ${page.name}` : "Template" };
}

/** O editor aberto num template. A página de um domínio usa o mesmo editor em /dominios/[id]/paginas/[pageId]. */
export default async function SlugEditorPage({ params }: { params: Params }) {
  const { id, slugId } = await params;
  const [page, slug] = await Promise.all([getPageWithSlugs(id), getSlug(slugId)]);
  if (!page || !slug || slug.page_id !== page.id) notFound();

  return (
    <PageEditor
      page={page}
      slugs={page.slugs}
      slug={slug}
      domains={[]}
      scope="template"
      placeholders={null}
      actions={{
        save: saveEditor,
        createSlug: createSlug.bind(null, page.id),
        renameSlug,
        toggleSlug,
        deleteSlug,
        deletePage: deletePage.bind(null, page.id),
      }}
      nav={{
        // Volta para a pasta onde o template está, não para a raiz.
        backHref: page.folder_id ? `/paginas?pasta=${page.folder_id}` : "/paginas",
        backTitle: "Back to templates",
        slugHref: `/paginas/${page.id}/slugs/{slug}`,
        afterDeleteHref: "/paginas",
      }}
    />
  );
}
