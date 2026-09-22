import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { listFolders, listPages } from "@/lib/pages/queries";
import { PagesBrowser } from "./pages-browser";

export const metadata: Metadata = {
  title: "Páginas",
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
      <PageHeader title="Páginas" description="Cada página tem um nome, um tipo e uma ou mais slugs com HTML. Organize em pastas; os domínios apontam para as páginas." />
      <PagesBrowser folders={folders} pages={pages} currentFolderId={currentFolderId} />
    </>
  );
}
