import type { ComponentType, SVGProps } from "react";
import {
  AbTestIcon,
  AccountIcon,
  ApiKeyIcon,
  BillingIcon,
  CampaignIcon,
  ConversionsIcon,
  DashboardIcon,
  DocsIcon,
  GlobeIcon,
  McpIcon,
  PagesIcon,
  SupportIcon,
  TutorialsIcon,
  WorkspaceIcon,
} from "@/components/icons";

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

/**
 * O menu do painel, em grupos como no layout de referência. Só Dashboard,
 * Pages e Domains têm rota de verdade; o resto é `soon` — visual, para o
 * layout ficar completo sem fingir que a funcionalidade existe.
 */
export const navGroups: NavGroup[] = [
  {
    items: [
      { href: "/", label: "Dashboard", description: "Overview of your workspace.", icon: DashboardIcon },
      { href: "/paginas", label: "Pages", description: "Create and edit your pages' HTML.", icon: PagesIcon },
      { href: "/dominios", label: "Domains", description: "Point domains and route each path.", icon: GlobeIcon },
      { href: "/campaigns", label: "Campaigns", icon: CampaignIcon, soon: true },
      { href: "/ab-tests", label: "A/B Tests", icon: AbTestIcon, soon: true },
    ],
  },
  {
    title: "Account",
    items: [
      { href: "/conversions", label: "Conversions", icon: ConversionsIcon, soon: true },
      { href: "/billing", label: "Billing", icon: BillingIcon, soon: true },
      { href: "/workspace", label: "Workspace", icon: WorkspaceIcon, soon: true },
      { href: "/account", label: "Account", icon: AccountIcon, soon: true },
    ],
  },
  {
    title: "Support",
    items: [
      { href: "/support", label: "Support", icon: SupportIcon, soon: true },
      { href: "/documentation", label: "Documentation", icon: DocsIcon, soon: true },
      { href: "/tutorials", label: "Tutorials", icon: TutorialsIcon, soon: true },
    ],
  },
  {
    title: "Advanced",
    items: [
      { href: "/api-keys", label: "API Keys", icon: ApiKeyIcon, soon: true },
      { href: "/mcp", label: "MCP", icon: McpIcon, soon: true },
    ],
  },
];

/** As seções reais (com rota), para atalhos na tela inicial. */
export const liveSections: NavItem[] = navGroups[0].items.filter((i) => !i.soon && i.href !== "/");
