import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Funnel",
};

export default function FunilPage() {
  return (
    <>
      <PageHeader title="Funnel" />
      <EmptyState title="Nothing here yet" description="This section is still empty." />
    </>
  );
}
