import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O editor manda o HTML inteiro de uma slug numa server action. O limite
  // padrão é 1 MB, e uma landing com CSS/JS embutidos passa disso fácil.
  // O teto de verdade (5 MB) é conferido dentro da action.
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
  poweredByHeader: false,
};

export default nextConfig;
