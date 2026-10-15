import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageEditor } from "@/components/editor/page-editor";
import { getUpsellPageForEditor } from "@/lib/pages/upsell";
import { createSlug, deleteSlug, renameSlug, toggleSlug } from "../../../../templates/actions";
import { deleteUpsellPage, saveUpsellPage } from "../../../actions";

type Params = Promise<{ id: string; pageId: string }>;
type SearchParams = Promise<{ slug?: string; step?: string; group?: string; preview?: string }>;

const STEP_RE = /^up[1-5]$/;
const GROUP_RE = /^g[a-z0-9]{1,12}$/;

export const metadata: Metadata = {
  title: "Upsell page",
};

/**
 * The editor opened on an upsell page (scope VENDOR, kind UPSELL) of the
 * funnel's product and platform. Opened from a group (`?step=up1&group=g…`),
 * its preview fills {{upsell.offer}} and {{upsell.downsellN}} with that group's
 * offers; `?preview=1` opens it in Preview.
 */
export default async function UpsellPageEditorPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id, pageId }, sp] = await Promise.all([params, searchParams]);
  const from = typeof sp.step === "string" && STEP_RE.test(sp.step) && typeof sp.group === "string" && GROUP_RE.test(sp.group) ? { step: sp.step, group: sp.group } : null;
  const data = await getUpsellPageForEditor(id, pageId, typeof sp.slug === "string" ? sp.slug : null, from);
  if (!data) notFound();
  const keep = from ? `&step=${from.step}&group=${from.group}` : "";

  return (
    <PageEditor
      // Switching slugs only changes the query string: the key forces the editor to restart with the new slug's HTML.
      key={data.slug.slug}
      page={data.page}
      slugs={data.slugs}
      slug={data.slug}
      domains={data.domain ? [data.domain] : []}
      scope="upsell"
      placeholders={data.placeholders}
      startInPreview={sp.preview === "1"}
      actions={{
        save: saveUpsellPage.bind(null, id),
        createSlug: createSlug.bind(null, pageId),
        renameSlug: renameSlug.bind(null, pageId),
        toggleSlug: toggleSlug.bind(null, pageId),
        deleteSlug: deleteSlug.bind(null, pageId),
        deletePage: deleteUpsellPage.bind(null, id, pageId),
      }}
      nav={{
        backHref: `/upsells/${id}`,
        backTitle: `Back to ${data.funnel.name}`,
        slugHref: `/upsells/${id}/pages/${pageId}?slug={slug}${keep}`,
        afterDeleteHref: `/upsells/${id}`,
      }}
    />
  );
}
