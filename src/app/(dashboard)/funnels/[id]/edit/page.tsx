import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageEditor } from "@/components/editor/page-editor";
import { getFunnelPageForEditor, listTemplates } from "@/lib/pages/queries";
import { createFunnelSlug, deleteFunnelSlug, removeFunnelPage, renameFunnelSlug, saveFunnelPage, toggleFunnelSlug } from "../../actions";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ slug?: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const data = await getFunnelPageForEditor(id, null);
  return { title: data ? `Edit: ${data.page.name}` : "Funnel page" };
}

/**
 * The editor opened on a funnel page (pages.funnels). The slug comes in
 * `?slug=/path` (without it, the root or the first one). As with templates,
 * the preview shows the raw placeholders.
 */
export default async function FunnelPageEditorPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, { slug }] = await Promise.all([params, searchParams]);
  const [data, templates] = await Promise.all([getFunnelPageForEditor(id, typeof slug === "string" ? slug : null), listTemplates()]);
  if (!data) notFound();
  const back = data.mainFunnelId ? `/funnels?f=${data.mainFunnelId}` : "/funnels?f=unlinked";

  return (
    <PageEditor
      // Switching slugs only changes the query string: the key forces the editor to restart with the new slug's HTML.
      key={data.slug.slug}
      page={data.page}
      slugs={data.slugs}
      slug={data.slug}
      domains={[]}
      scope="funnel"
      placeholders={null}
      templates={templates.map((t) => ({ id: t.id, name: t.name }))}
      actions={{
        save: saveFunnelPage.bind(null, data.funnelId),
        createSlug: createFunnelSlug.bind(null, data.funnelId, id),
        renameSlug: renameFunnelSlug.bind(null, data.funnelId, id),
        toggleSlug: toggleFunnelSlug.bind(null, data.funnelId, id),
        deleteSlug: deleteFunnelSlug.bind(null, data.funnelId, id),
        deletePage: removeFunnelPage.bind(null, data.funnelId, id),
      }}
      nav={{
        backHref: back,
        backTitle: "Back to the funnel",
        slugHref: `/funnels/${id}/edit?slug={slug}`,
        afterDeleteHref: back,
      }}
    />
  );
}
