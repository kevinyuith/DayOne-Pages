import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { listFolders, listPages } from "@/lib/pages/queries";
import { PagesBrowser } from "./pages-browser";

export const metadata: Metadata = {
  title: "Page templates",
};

/**
 * Pages screen: cards in folders, modeled on hidepages. The open folder
 * comes from `?folder=<id>`; an unknown id falls back to the root without error.
 */
export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ folder?: string }> }) {
  const [{ folder }, pages, folders] = await Promise.all([searchParams, listPages(), listFolders()]);
  const currentFolderId = folder && folders.some((f) => f.id === folder) ? folder : null;

  return (
    <>
      <PageHeader title="Page templates" />
      <PagesBrowser folders={folders} pages={pages} currentFolderId={currentFolderId} />
    </>
  );
}
