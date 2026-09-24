/** O cabeçalho de uma tela do painel: só o título (sem texto de descrição embaixo). */
export function PageHeader({ title }: { title: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    </header>
  );
}
