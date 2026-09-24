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
      <PageHeader title="Page templates" />
      <PagesBrowser folders={folders} pages={pages} currentFolderId={currentFolderId} />
    </>
  );
}
