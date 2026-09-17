import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Páginas",
};

export default function PaginasPage() {
  return (
    <>
      <PageHeader
        title="Páginas"
        description="Crie e organize as páginas do seu site."
      />
      <EmptyState
        title="Nenhuma página criada"
        description="As páginas que você criar aparecerão nesta lista."
      />
    </>
  );
}
