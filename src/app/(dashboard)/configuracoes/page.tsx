import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAiStatus } from "@/lib/ai-settings";
import { AiSettings } from "./ai-settings";
import { DnsResolver } from "./dns-resolver";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function ConfiguracoesPage() {
  const ai = await getAiStatus();

  return (
    <>
      <PageHeader title="Settings" />

      <div className="space-y-6">
        <AiSettings status={ai} />
        <DnsResolver />
      </div>
    </>
  );
}
