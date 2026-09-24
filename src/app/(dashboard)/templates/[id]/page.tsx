import { redirect } from "next/navigation";

/** The page itself has no screen: go to the editor (at the root or the first slug). */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/templates/${id}/edit`);
}
