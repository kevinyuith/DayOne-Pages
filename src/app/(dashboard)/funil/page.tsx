import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Funil",
};

export default function FunilPage() {
  return (
    <>
      <PageHeader title="Funil" />
      <EmptyState title="Nada aqui ainda" description="Esta seção ainda está vazia." />
    </>
  );
}
