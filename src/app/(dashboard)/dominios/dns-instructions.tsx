/**
 * Como apontar o domínio. Cloudflare na frente, origem só HTTP.
 */
export function DnsInstructions({ serverIp }: { serverIp: string }) {
  const ip = serverIp || "<IP do servidor — defina SERVER_IP>";
  return (
    <aside className="rounded-xl border border-border bg-surface p-5 text-sm">
      <h2 className="text-sm font-semibold">Como apontar o domínio (Cloudflare)</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted">
        <li>
          Em <strong className="text-foreground">DNS</strong>, crie um registro <code className="rounded bg-foreground/5 px-1">A</code> com nome{" "}
          <code className="rounded bg-foreground/5 px-1">@</code> apontando para <code className="rounded bg-foreground/5 px-1">{ip}</code>, com o proxy{" "}
          <strong className="text-foreground">ligado</strong> (nuvem laranja).
        </li>
        <li>
          Crie um <code className="rounded bg-foreground/5 px-1">CNAME</code> com nome <code className="rounded bg-foreground/5 px-1">www</code> apontando para{" "}
          <code className="rounded bg-foreground/5 px-1">@</code>, também com proxy ligado.
        </li>
        <li>
          Em <strong className="text-foreground">SSL/TLS</strong>, modo <strong className="text-foreground">Flexible</strong> (o servidor recebe só HTTP) e ligue{" "}
          <em>Always Use HTTPS</em>.
        </li>
        <li>
          Em <strong className="text-foreground">Speed → Optimization</strong>, desligue <em>Auto Minify</em> e <em>Rocket Loader</em> (eles reescrevem o HTML).
        </li>
        <li>
          Se usar regras de WAF/Bot Fight Mode, libere o path <code className="rounded bg-foreground/5 px-1">/_health</code>, que o botão{" "}
          <em>Verificar</em> consulta.
        </li>
      </ol>
      <p className="mt-3 text-xs text-muted">Alterações de página e de rota entram no ar em até 5 minutos (cache do servidor).</p>
    </aside>
  );
}
