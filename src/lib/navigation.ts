import type { ComponentType, SVGProps } from "react";
import { GlobeIcon, GridIcon, PagesIcon } from "@/components/icons";

export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

export const navigation: NavItem[] = [
  {
    href: "/",
    label: "Visão geral",
    description: "Resumo do seu projeto.",
    icon: GridIcon,
  },
  {
    href: "/dominio",
    label: "Domínio",
    description: "Configure o domínio do seu site.",
    icon: GlobeIcon,
  },
  {
    href: "/paginas",
    label: "Páginas",
    description: "Crie e organize as páginas do seu site.",
    icon: PagesIcon,
  },
];

export const sections = navigation.filter((item) => item.href !== "/");
