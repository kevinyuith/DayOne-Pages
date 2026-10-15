import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseRange } from "@/lib/pages/dashboard-filters";
import { getUpsellEditor } from "@/lib/pages/upsell";
import { UpsellEditor } from "./upsell-editor";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ range?: string }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  return { title: UUID_RE.test(id) ? "Upsell funnel" : "Upsells" };
}

/**
 * An upsell funnel: the routes across the steps, the selected cell's Page › VSL ›
 * CTA › Downsell versions (or a route), the draft and its history. The numbers'
 * period is `?range=` (the Dashboard's; the last 7 New York days by default).
 */
export default async function UpsellFunnelPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, { range }] = await Promise.all([params, searchParams]);
  if (!UUID_RE.test(id)) notFound();
  const data = await getUpsellEditor(id, typeof range === "string" ? parseRange(range) : "7d");
  if (!data) notFound();
  // A publish, discard or restore reloads the page: the editor starts over from the new version.
  return <UpsellEditor key={data.updatedAt} data={data} />;
}
