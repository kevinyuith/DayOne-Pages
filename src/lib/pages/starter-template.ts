/**
 * O HTML de uma página nova, e os ajudantes que o editor usa sobre HTML.
 *
 * O servidor serve o conteúdo da slug EXATAMENTE como está gravado. Por isso
 * uma página deve ser um documento completo (doctype, head, body). Quem cola
 * um fragmento (`<div ...>` com CSS e JS dentro) usa "Envolver fragmento",
 * que o embrulha num documento mínimo.
 */

export const STARTER_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nova página</title>
  <meta name="robots" content="noindex">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #171717; background: #fafafa; }
    main { max-width: 720px; margin: 0 auto; padding: 64px 24px; }
    h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 16px; }
    p { font-size: 1.05rem; line-height: 1.6; margin: 0 0 24px; color: #52525b; }
    .cta { display: inline-block; padding: 14px 28px; border-radius: 10px; background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>Sua página começa aqui</h1>
    <p>Edite este HTML no painel. Use URLs absolutas (https://...) para imagens e scripts.</p>
    <a class="cta" href="#">Chamada para ação</a>
  </main>
</body>
</html>
`;

/** É um documento completo (começa com doctype ou <html>)? */
export function isFullDocument(html: string): boolean {
  return /^\s*(<!doctype|<html)/i.test(html);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Embrulha um fragmento num documento mínimo. */
export function wrapFragment(fragment: string, opts: { title?: string; lang?: string } = {}): string {
  const title = escapeHtml(opts.title ?? "Página");
  const lang = escapeHtml(opts.lang ?? "pt-BR");
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>html, body { margin: 0; padding: 0; }</style>
</head>
<body>
${fragment}
</body>
</html>
`;
}

/**
 * Injeta `<base href>` para o preview: um documento em `srcDoc` tem como base
 * a origem do dashboard, então `/img/x.png` bateria no dashboard. Com a base
 * apontando para o domínio, os caminhos relativos resolvem no lugar certo.
 * `target="_blank"` tira os cliques de dentro do iframe.
 */
export function injectBase(html: string, href: string): string {
  const tag = `<base href="${escapeHtml(href)}" target="_blank">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  return `${tag}\n${html}`;
}
