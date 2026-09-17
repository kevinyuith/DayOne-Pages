import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Domínio",
};

export default function DominioPage() {
  return (
    <>
      <PageHeader
        title="Domínio"
        description="Configure o domínio do seu site."
      />
      <EmptyState
        title="Nenhum domínio configurado"
        description="Quando você conectar um domínio, ele aparecerá aqui."
      />
    </>
  );
}
