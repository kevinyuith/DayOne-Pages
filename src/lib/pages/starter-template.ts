/**
 * The HTML of a new page, and the HTML helpers the editor uses.
 *
 * The server serves the slug's content EXACTLY as saved. That's why a page
 * must be a complete document (doctype, head, body). Whoever pastes a
 * fragment (`<div ...>` with CSS and JS inside) uses "Wrap fragment", which
 * wraps it in a minimal document.
 */

export const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>New page</title>
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
    <h1>Your page starts here</h1>
    <p>Edit this HTML in the dashboard. Use absolute URLs (https://...) for images and scripts.</p>
    <a class="cta" href="#">Call to action</a>
  </main>
</body>
</html>
`;

/** Is it a complete document (starts with doctype or <html>)? */
export function isFullDocument(html: string): boolean {
  return /^\s*(<!doctype|<html)/i.test(html);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Wraps a fragment in a minimal document. */
export function wrapFragment(fragment: string, opts: { title?: string; lang?: string } = {}): string {
  const title = escapeHtml(opts.title ?? "Page");
  const lang = escapeHtml(opts.lang ?? "en");
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
 * Injects `<base href>` for the preview: a document in `srcDoc` uses the
 * dashboard's origin as its base, so `/img/x.png` would hit the dashboard. With
 * the base pointing at the domain, relative paths resolve in the right place.
 * `target="_blank"` takes clicks out of the iframe.
 */
export function injectBase(html: string, href: string): string {
  const tag = `<base href="${escapeHtml(href)}" target="_blank">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  return `${tag}\n${html}`;
}
