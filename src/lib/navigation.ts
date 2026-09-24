import type { ComponentType, SVGProps } from "react";
import { DashboardIcon, FunnelIcon, GlobeIcon, LogsIcon, PagesIcon, GearIcon } from "@/components/icons";

export type NavItem = {
  href: string;
  label: string;
  description?: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Visual-only item: the route doesn't exist yet. Not a link; gets a "Soon" badge. */
  soon?: boolean;
};

export type NavGroup = {
  title?: string;
  items: NavItem[];
};

/** The dashboard menu. Only the sections that actually exist. */
export const navGroups: NavGroup[] = [
  {
    items: [
      { href: "/", label: "Dashboard", description: "Overview of your workspace.", icon: DashboardIcon },
      { href: "/templates", label: "Page templates", description: "Build page templates; each domain gets its own copy.", icon: PagesIcon },
      { href: "/domains", label: "Domains", description: "Point domains and route each path.", icon: GlobeIcon },
      { href: "/funnels", label: "Funnel", description: "Your funnel.", icon: FunnelIcon },
      { href: "/logs", label: "Logs", description: "Every request, one row each.", icon: LogsIcon },
      { href: "/settings", label: "Settings", description: "AI and DNS settings.", icon: GearIcon },
    ],
  },
];

/** Cookie with the sidebar state: "expanded" or "collapsed" (default). */
export const SIDEBAR_COOKIE = "sidebar";

/** The real sections (with a route), for shortcuts on the home screen. */
export const liveSections: NavItem[] = navGroups[0].items.filter((i) => !i.soon && i.href !== "/");
