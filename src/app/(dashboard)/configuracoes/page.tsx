import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { listDetectionRules } from "@/lib/pages/queries";
import { RulesList } from "./rules-list";
import { DnsResolver } from "./dns-resolver";

export const metadata: Metadata = {
  title: "Configurações",
};

export default async function ConfiguracoesPage() {
  const rules = await listDetectionRules();

  return (
    <>
      <PageHeader
        title="Configurações"
        description="Configure as regras que definem quem é bot ou suspeito. Use regex, padrões CIDR, países, etc."
      />

      <div className="space-y-6">
        <RulesList rules={rules} />
        <DnsResolver />
      </div>
    </>
  );
}
