import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageEditor } from "@/components/editor/page-editor";
import { placeholderValues } from "@/lib/pages/placeholders";
import { getDomainPageForEditor, listTemplates } from "@/lib/pages/queries";
import { removeDomainPage } from "../../../actions";
import { createDomainSlug, deleteDomainSlug, renameDomainSlug, saveDomainPage, toggleDomainSlug } from "../actions";

type Params = Promise<{ id: string; pageId: string }>;
type SearchParams = Promise<{ slug?: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id, pageId } = await params;
  const data = await getDomainPageForEditor(id, pageId, null);
  return { title: data ? `Edit: ${data.page.name} · ${data.domain.domain}` : "Page" };
}

/**
 * The editor opened on a domain page (domains.site). The slug comes in
 * `?slug=/path` (without it, the root or the first one). The preview swaps
 * the placeholders for this domain's data.
 */
export default async function DomainPageEditorPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id, pageId }, { slug }] = await Promise.all([params, searchParams]);
  const [data, templates] = await Promise.all([getDomainPageForEditor(id, pageId, typeof slug === "string" ? slug : null), listTemplates()]);
  if (!data) notFound();

  return (
    <PageEditor
      // Switching slugs only changes the query string: the key forces the editor to restart with the new slug's HTML.
      key={data.slug.slug}
      page={data.page}
      slugs={data.slugs}
      slug={data.slug}
      domains={[data.domain.domain]}
      scope="domain"
      // Preview as an English-speaking visitor; live, lang/language/date follow the visitor's browser.
      placeholders={placeholderValues({ domain: data.domain.domain, stored: data.domain.placeholders, path: data.slug.slug, lang: "en" })}
      templates={templates.map((t) => ({ id: t.id, name: t.name }))}
      actions={{
        save: saveDomainPage.bind(null, id),
        createSlug: createDomainSlug.bind(null, id, pageId),
        renameSlug: renameDomainSlug.bind(null, id, pageId),
        toggleSlug: toggleDomainSlug.bind(null, id, pageId),
        deleteSlug: deleteDomainSlug.bind(null, id, pageId),
        deletePage: removeDomainPage.bind(null, id, pageId),
      }}
      nav={{
        backHref: `/domains/${id}`,
        backTitle: `Back to ${data.domain.domain}`,
        slugHref: `/domains/${id}/pages/${pageId}?slug={slug}`,
        afterDeleteHref: `/domains/${id}`,
      }}
    />
  );
}
