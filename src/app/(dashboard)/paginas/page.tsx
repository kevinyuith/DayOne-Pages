import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { listFolders, listPages } from "@/lib/pages/queries";
import { PagesBrowser } from "./pages-browser";

export const metadata: Metadata = {
  title: "Templates de página",
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
        title="Templates de página"
        description="Cada template tem um nome, um tipo e uma ou mais slugs com HTML. Um domínio recebe uma CÓPIA do template: editar o template não muda as cópias, e editar a cópia (na tela do domínio) não muda o template."
      />
      <PagesBrowser folders={folders} pages={pages} currentFolderId={currentFolderId} />
    </>
  );
}
