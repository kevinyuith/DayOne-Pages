/** The header of a panel screen: just the title (no description text below it). */
export function PageHeader({ title }: { title: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    </header>
  );
}
