import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { listFolders, listPages, listTemplates } from "@/lib/pages/queries";
import { PagesBrowser } from "../paginas/pages-browser";

export const metadata: Metadata = {
  title: "Funnel",
};

/**
 * A biblioteca de funis: o mesmo explorador da tela de templates (pastas,
 * busca, arrastar), só com funis e com a árvore de pastas dela. Abrir um
 * funil mostra as etapas, as amostras e o teste A/B em cada domínio.
 */
export default async function FunilPage({ searchParams }: { searchParams: Promise<{ pasta?: string }> }) {
  const [{ pasta }, funnels, folders, templates] = await Promise.all([searchParams, listPages("FUNNEL"), listFolders("FUNNEL"), listTemplates()]);
  const currentFolderId = pasta && folders.some((f) => f.id === pasta) ? pasta : null;

  return (
    <>
      <PageHeader
        title="Funnel"
        description="Each funnel has Pre Lander → Lander → Backredirect, and each step can have several samples for an A/B test. A domain gets a COPY of the funnel: the test runs on the copy, with its own weights and results."
      />
      <PagesBrowser
        scope="FUNNEL"
        folders={folders}
        pages={funnels}
        currentFolderId={currentFolderId}
        templates={templates.filter((t) => t.kind !== "FUNNEL").map((t) => ({ id: t.id, name: t.name }))}
      />
    </>
  );
}
