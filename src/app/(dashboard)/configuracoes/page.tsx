import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAiStatus } from "@/lib/ai-settings";
import { listDetectionRules } from "@/lib/pages/queries";
import { AiSettings } from "./ai-settings";
import { RulesList } from "./rules-list";
import { DnsResolver } from "./dns-resolver";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function ConfiguracoesPage() {
  const [rules, ai] = await Promise.all([listDetectionRules(), getAiStatus()]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="The AI for template variations and the rules that decide who is a bot or suspicious (regex, CIDR, countries…)."
      />

      <div className="space-y-6">
        <AiSettings status={ai} />
        <RulesList rules={rules} />
        <DnsResolver />
      </div>
    </>
  );
}
