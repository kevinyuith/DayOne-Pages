import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { sections } from "@/lib/navigation";
import { countOverview } from "@/lib/pages/queries";

export default async function OverviewPage() {
  const counts = await countOverview();

  const stats = [
    { label: "Domínios", value: counts.domains, detail: `${counts.domainsActive} ativos`, href: "/dominios" },
    { label: "Páginas", value: counts.pages, detail: `${counts.pagesPublished} publicadas`, href: "/paginas" },
    { label: "Rotas", value: counts.routes, detail: "regras por path", href: "/dominios" },
  ];

  return (
    <>
      <PageHeader title="Visão geral" description="Bem-vindo ao DayOne Pages. Escolha uma seção para começar." />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent">
            <p className="text-sm text-muted">{s.label}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{s.value}</p>
            <p className="mt-1 text-xs text-muted">{s.detail}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <Link
              key={section.href}
              href={section.href}
              className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent"
            >
              <div className="flex size-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Icon className="size-5" />
              </div>
              <h2 className="mt-4 font-semibold">{section.label}</h2>
              <p className="mt-1 text-sm text-muted">{section.description}</p>
            </Link>
          );
        })}
      </div>
    </>
  );
}
