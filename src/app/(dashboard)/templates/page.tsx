import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { foldersFromPaths, isFolderPath } from "@/lib/pages/folders";
import { listPages } from "@/lib/pages/queries";
import { PagesBrowser } from "./pages-browser";

export const metadata: Metadata = {
  title: "Page templates",
};

/**
 * Pages screen: cards in folders, modeled on hidepages. The folders come from
 * the templates' paths (pages.pages.folder); the open one from
 * `?folder=<path>` — any valid path opens (a new folder has no template yet),
 * an invalid one falls back to the root without error.
 */
export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ folder?: string }> }) {
  const [{ folder }, pages] = await Promise.all([searchParams, listPages()]);
  const folders = foldersFromPaths(pages.map((p) => p.folder));
  const currentFolderId = isFolderPath(folder) ? folder : null;

  return (
    <>
      <PageHeader title="Page templates" />
      <PagesBrowser folders={folders} pages={pages} currentFolderId={currentFolderId} />
    </>
  );
}
