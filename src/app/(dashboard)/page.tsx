import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { sections } from "@/lib/navigation";

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Visão geral"
        description="Bem-vindo ao DayOne Pages. Escolha uma seção para começar."
      />
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
