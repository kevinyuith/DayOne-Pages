import type { ComponentType, SVGProps } from "react";
import { DashboardIcon, FunnelIcon, GlobeIcon, LogsIcon, PagesIcon, GearIcon } from "@/components/icons";

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
      { href: "/paginas", label: "Page templates", description: "Build page templates; each domain gets its own copy.", icon: PagesIcon },
      { href: "/dominios", label: "Domains", description: "Point domains and route each path.", icon: GlobeIcon },
      { href: "/funil", label: "Funnel", description: "Your funnel.", icon: FunnelIcon },
      { href: "/logs", label: "Logs", description: "Every request, one row each.", icon: LogsIcon },
      { href: "/configuracoes", label: "Settings", description: "Bot detection rules and settings.", icon: GearIcon },
    ],
  },
];

/** Cookie com o estado do menu lateral: "expanded" ou "collapsed" (padrão). */
export const SIDEBAR_COOKIE = "sidebar";

/** As seções reais (com rota), para atalhos na tela inicial. */
export const liveSections: NavItem[] = navGroups[0].items.filter((i) => !i.soon && i.href !== "/");
