/**
 * HTML trazido de outro site ("Criar template → copiar de um link"), pronto
 * para virar template: os endereços relativos (imagens, CSS, scripts,
 * srcset, url() do CSS, links e forms) viram absolutos em relação à página
 * de origem. Sem isso, `/img/logo.png` quebraria ao ser servido de outro
 * domínio. Os links continuam apontando para o site de origem; troque-os no
 * painel Links do editor.
 *
 * `<base>` sai (os endereços já estão resolvidos). `#âncora`, `data:`,
 * `mailto:`, `tel:`, `javascript:` e marcadores `{{...}}` ficam como estão.
 *
 * Só no cliente (DOMParser).
 */

const URL_ATTRS = ["src", "href", "poster", "action", "background", "data-src", "data-href", "data-bg", "data-background"];
const SRCSET_ATTRS = ["srcset", "data-srcset"];
const KEEP = /^(#|data:|mailto:|tel:|sms:|javascript:|blob:|about:|\{\{)/i;

function absolute(value: string, base: string): string {
  const v = value.trim();
  if (!v || KEEP.test(v)) return value;
  try {
    return new URL(v, base).toString();
  } catch {
    return value;
  }
}

function absoluteSrcset(value: string, base: string): string {
  return value
    .split(",")
    .map((part) => {
      const [url, ...descriptor] = part.trim().split(/\s+/);
      return url ? [absolute(url, base), ...descriptor].join(" ") : part;
    })
    .join(", ");
}

function absoluteCss(css: string, base: string): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, q: string, url: string) => `url(${q}${absolute(url, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, q: string, url: string) => `@import ${q}${absolute(url, base)}${q}`);
}

export function importHtml(html: string, pageUrl: string): { html: string; title: string | null } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  const base = baseHref ? absolute(baseHref, pageUrl) : pageUrl;
  doc.querySelectorAll("base").forEach((b) => b.remove());

  for (const attr of URL_ATTRS) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => el.setAttribute(attr, absolute(el.getAttribute(attr) ?? "", base)));
  }
  for (const attr of SRCSET_ATTRS) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => el.setAttribute(attr, absoluteSrcset(el.getAttribute(attr) ?? "", base)));
  }
  doc.querySelectorAll("[style]").forEach((el) => el.setAttribute("style", absoluteCss(el.getAttribute("style") ?? "", base)));
  doc.querySelectorAll("style").forEach((s) => {
    s.textContent = absoluteCss(s.textContent ?? "", base);
  });

  const title = doc.querySelector("title")?.textContent?.trim() || null;
  const doctype = /^\s*<!doctype/i.test(html) ? "<!doctype html>\n" : "";
  return { html: doctype + doc.documentElement.outerHTML, title };
}
