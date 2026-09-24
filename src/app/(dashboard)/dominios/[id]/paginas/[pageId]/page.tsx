import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageEditor } from "@/app/(dashboard)/paginas/[id]/slugs/[slugId]/page-editor";
import { placeholderValues } from "@/lib/pages/placeholders";
import { funnelStatsByStep, getDomainPageForEditor, listTemplates } from "@/lib/pages/queries";
import { localMidnight } from "@/lib/time-zone";
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
 * O editor aberto numa página do domínio (domains.site). A slug vem em
 * `?slug=/caminho` (sem ela, a raiz ou a primeira). O preview troca os
 * marcadores pelos dados deste domínio.
 */
export default async function DomainPageEditorPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id, pageId }, { slug }] = await Promise.all([params, searchParams]);
  // Server Component dinâmico: ler o relógio por request é intencional.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [data, templates, stats] = await Promise.all([
    getDomainPageForEditor(id, pageId, typeof slug === "string" ? slug : null),
    listTemplates(),
    // Teste A/B: visitantes únicos de cada amostra nos últimos 30 dias (de Nova York, com hoje).
    funnelStatsByStep([id], new Date(localMidnight(nowMs, 29))),
  ]);
  if (!data) notFound();

  return (
    <PageEditor
      // A troca de slug muda só a query string: a key força o editor a recomeçar com o HTML da slug nova.
      key={data.slug.slug}
      page={data.page}
      slugs={data.slugs}
      slug={data.slug}
      domains={[data.domain.domain]}
      scope="domain"
      // Preview como um visitante de língua inglesa; no ar, lang/language/date seguem o navegador de quem visita.
      placeholders={placeholderValues({ domain: data.domain.domain, stored: data.domain.placeholders, path: data.slug.slug, lang: "en" })}
      funnelStats={Object.fromEntries(stats.get(id) ?? [])}
      templates={templates.filter((t) => t.kind !== "FUNNEL").map((t) => ({ id: t.id, name: t.name }))}
      actions={{
        save: saveDomainPage.bind(null, id),
        createSlug: createDomainSlug.bind(null, id, pageId),
        renameSlug: renameDomainSlug.bind(null, id, pageId),
        toggleSlug: toggleDomainSlug.bind(null, id, pageId),
        deleteSlug: deleteDomainSlug.bind(null, id, pageId),
        deletePage: removeDomainPage.bind(null, id, pageId),
      }}
      nav={{
        backHref: `/dominios/${id}`,
        backTitle: `Back to ${data.domain.domain}`,
        slugHref: `/dominios/${id}/paginas/${pageId}?slug={slug}`,
        afterDeleteHref: `/dominios/${id}`,
      }}
    />
  );
}
