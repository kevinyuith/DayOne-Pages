import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageEditor } from "@/components/editor/page-editor";
import { getTemplateForEditor, listTemplates } from "@/lib/pages/queries";
import { createSlug, deletePage, deleteSlug, renameSlug, saveEditor, toggleSlug } from "../../actions";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ slug?: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const data = await getTemplateForEditor(id, null);
  return { title: data ? `Edit: ${data.page.name}` : "Template" };
}

/**
 * The editor opened on a template. The slug comes in `?slug=/path` (without it,
 * the root or the first one). A domain's page uses the same editor at
 * /domains/[id]/pages/[pageId], and a funnel's at /funnels/[id]/edit.
 */
export default async function TemplateEditorPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, { slug }] = await Promise.all([params, searchParams]);
  const [data, templates] = await Promise.all([getTemplateForEditor(id, typeof slug === "string" ? slug : null), listTemplates()]);
  if (!data) notFound();
  const { page } = data;

  return (
    <PageEditor
      // Switching slugs only changes the query string: the key forces the editor to restart with the new slug's HTML.
      key={data.slug.slug}
      page={page}
      slugs={data.slugs}
      slug={data.slug}
      domains={[]}
      scope="template"
      placeholders={null}
      templates={templates.filter((t) => t.id !== page.id).map((t) => ({ id: t.id, name: t.name }))}
      actions={{
        save: saveEditor,
        createSlug: createSlug.bind(null, page.id),
        renameSlug: renameSlug.bind(null, page.id),
        toggleSlug: toggleSlug.bind(null, page.id),
        deleteSlug: deleteSlug.bind(null, page.id),
        deletePage: deletePage.bind(null, page.id),
      }}
      nav={{
        // Go back to the template's folder, not to the root.
        backHref: page.folder_id ? `/templates?folder=${page.folder_id}` : "/templates",
        backTitle: "Back to templates",
        slugHref: `/templates/${page.id}/edit?slug={slug}`,
        afterDeleteHref: "/templates",
      }}
    />
  );
}
