import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPageWithSlugs, getSlug, listTemplates } from "@/lib/pages/queries";
import { createSlug, deletePage, deleteSlug, renameSlug, saveEditor, toggleSlug } from "../../../actions";
import { PageEditor } from "./page-editor";

type Params = Promise<{ id: string; slugId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const page = await getPageWithSlugs(id);
  return { title: page ? `Edit: ${page.name}` : "Template" };
}

/** O editor aberto num template. A página de um domínio usa o mesmo editor em /dominios/[id]/paginas/[pageId]. */
export default async function SlugEditorPage({ params, searchParams }: { params: Params; searchParams: Promise<{ sample?: string }> }) {
  const [{ id, slugId }, { sample }] = await Promise.all([params, searchParams]);
  const [page, slug, templates] = await Promise.all([getPageWithSlugs(id), getSlug(slugId), listTemplates()]);
  if (!page || !slug || slug.page_id !== page.id) notFound();
  // Funil: o editor volta para a tela do funil (etapas, amostras e o teste A/B).
  const funnel = page.kind === "FUNNEL";

  return (
    <PageEditor
      page={page}
      slugs={page.slugs}
      slug={slug}
      domains={[]}
      scope="template"
      placeholders={null}
      // A tela Funil abre o editor já na amostra clicada.
      initialSampleId={typeof sample === "string" && /^p_[a-z0-9]{1,16}$/.test(sample) ? sample : null}
      templates={templates.filter((t) => t.kind !== "FUNNEL" && t.id !== page.id).map((t) => ({ id: t.id, name: t.name }))}
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
        backHref: funnel ? (page.funnel_id ? `/funil?f=${page.funnel_id}` : `/funil?f=unlinked`) : page.folder_id ? `/paginas?pasta=${page.folder_id}` : "/paginas",
        backTitle: funnel ? "Back to the funnel" : "Back to templates",
        slugHref: `/paginas/${page.id}/slugs/{slug}`,
        afterDeleteHref: funnel ? "/funil" : "/paginas",
      }}
    />
  );
}
