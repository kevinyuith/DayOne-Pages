import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { listFolders, listPages } from "@/lib/pages/queries";
import { PagesBrowser } from "./pages-browser";

export const metadata: Metadata = {
  title: "Page templates",
};

/**
 * Tela de páginas: cards em pastas, no modelo do hidepages. A pasta aberta
 * vem de `?pasta=<id>`; id desconhecido cai na raiz sem erro.
 */
export default async function PaginasPage({ searchParams }: { searchParams: Promise<{ pasta?: string }> }) {
  const [{ pasta }, pages, folders] = await Promise.all([searchParams, listPages(), listFolders()]);
  const currentFolderId = pasta && folders.some((f) => f.id === pasta) ? pasta : null;

  return (
    <>
      <PageHeader
        title="Page templates"
        description="Each template has a name, a type and one or more slugs with HTML. A domain gets a COPY of the template: editing the template doesn't change the copies, and editing the copy (on the domain screen) doesn't change the template."
      />
      <PagesBrowser folders={folders} pages={pages} currentFolderId={currentFolderId} />
    </>
  );
}
