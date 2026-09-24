/**
 * Widgets básicos do painel (Texto, Imagem, Vídeo, Botão, Container, HTML):
 * o HTML que cada um insere na página. Estilos inline para o bloco ficar
 * apresentável em qualquer página, sem depender do CSS dela.
 */

export const WIDGET_KEYS = ["text", "image", "video", "button", "container", "html"] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

export type WidgetDef = {
  key: WidgetKey;
  label: string;
  hint: string;
  /** O widget pede um valor (URL, HTML) antes de inserir. */
  prompt?: { label: string; placeholder: string };
};

export const WIDGETS: WidgetDef[] = [
  { key: "text", label: "Text", hint: "Text paragraph" },
  { key: "image", label: "Image", hint: "Image from a URL", prompt: { label: "Image URL", placeholder: "https://…/image.jpg" } },
  { key: "video", label: "Video", hint: "YouTube, Vimeo or embed", prompt: { label: "Video URL", placeholder: "https://www.youtube.com/watch?v=…" } },
  { key: "button", label: "Button", hint: "Call to action" },
  { key: "container", label: "Container", hint: "Blank section" },
  { key: "html", label: "HTML", hint: "Free-form HTML block", prompt: { label: "Block HTML", placeholder: "<div>…</div>" } },
];

const PLACEHOLDER_IMG =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400"><rect width="800" height="400" fill="#e4e4e7"/><text x="400" y="210" font-family="system-ui,sans-serif" font-size="28" fill="#71717a" text-anchor="middle">Image</text></svg>`,
  );

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** URL de vídeo → URL de embed (YouTube/Vimeo); outras voltam como estão. */
export function toEmbedUrl(url: string): string {
  const u = url.trim();
  const yt = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vm = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return u;
}

/** O HTML a inserir. `value` é o que o prompt do widget devolveu (se houver). */
export function widgetHtml(key: WidgetKey, value = ""): string {
  switch (key) {
    case "text":
      return `<p style="margin:0 0 16px;font-size:18px;line-height:1.6">New text. Double-click to edit.</p>`;
    case "image":
      return `<img src="${esc(value.trim() || PLACEHOLDER_IMG)}" alt="" style="display:block;max-width:100%;height:auto">`;
    case "video": {
      const src = esc(toEmbedUrl(value) || "about:blank");
      return `<div style="position:relative;width:100%;padding-top:56.25%"><iframe src="${src}" title="Video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe></div>`;
    }
    case "button":
      return `<a href="#" style="display:inline-block;padding:14px 28px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">Call to action</a>`;
    case "container":
      return `<section style="padding:32px 24px"><p style="margin:0">New container. Add other widgets inside it.</p></section>`;
    case "html":
      return value;
  }
}
