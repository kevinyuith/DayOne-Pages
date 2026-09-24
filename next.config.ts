import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The editor sends a slug's whole HTML in a server action. The default
  // limit is 1 MB, and a landing with inline CSS/JS easily goes past it.
  // The real cap (5 MB) is checked inside the action.
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
  poweredByHeader: false,
  // Old (Portuguese) dashboard addresses, for bookmarks and links already sent.
  async redirects() {
    return [
      { source: "/paginas/:id/editar", destination: "/templates/:id/edit", permanent: true },
      { source: "/paginas/:id/slugs/:slugId", destination: "/templates/:id/edit", permanent: true },
      { source: "/paginas/:path*", destination: "/templates/:path*", permanent: true },
      { source: "/dominios/:id/paginas/:pageId", destination: "/domains/:id/pages/:pageId", permanent: true },
      { source: "/dominios/:path*", destination: "/domains/:path*", permanent: true },
      { source: "/funil/:id/editar", destination: "/funnels/:id/edit", permanent: true },
      { source: "/funil/:path*", destination: "/funnels/:path*", permanent: true },
      { source: "/configuracoes/:path*", destination: "/settings/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
