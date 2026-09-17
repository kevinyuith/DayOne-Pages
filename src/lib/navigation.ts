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
    href: "/dominios",
    label: "Domínios",
    description: "Cadastre domínios e defina qual página responde em cada path.",
    icon: GlobeIcon,
  },
  {
    href: "/paginas",
    label: "Páginas",
    description: "Crie e edite o HTML das suas páginas.",
    icon: PagesIcon,
  },
];

export const sections = navigation.filter((item) => item.href !== "/");
