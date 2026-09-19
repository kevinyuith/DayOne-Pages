import type { ComponentType, SVGProps } from "react";
import { DashboardIcon, GlobeIcon, PagesIcon } from "@/components/icons";

export type NavItem = {
  href: string;
  label: string;
  description?: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Item apenas visual: rota ainda não existe. Não vira link, ganha selo "Soon". */
  soon?: boolean;
};

export type NavGroup = {
  title?: string;
  items: NavItem[];
};

/** O menu do painel. Só as seções que existem de verdade. */
export const navGroups: NavGroup[] = [
  {
    items: [
      { href: "/", label: "Dashboard", description: "Overview of your workspace.", icon: DashboardIcon },
      { href: "/paginas", label: "Pages", description: "Create and edit your pages' HTML.", icon: PagesIcon },
      { href: "/dominios", label: "Domains", description: "Point domains and route each path.", icon: GlobeIcon },
    ],
  },
];

/** As seções reais (com rota), para atalhos na tela inicial. */
export const liveSections: NavItem[] = navGroups[0].items.filter((i) => !i.soon && i.href !== "/");
