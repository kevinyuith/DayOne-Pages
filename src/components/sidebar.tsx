"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { SidebarIcon } from "@/components/icons";
import { navGroups, SIDEBAR_COOKIE } from "@/lib/navigation";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Recolhido = trilho de ícones que abre por cima do conteúdo no hover/foco
 * (sem empurrar a página). O botão fixa aberto. Vale só do md para cima: no
 * mobile o menu é a barra horizontal do topo, sempre com rótulos.
 *
 * 68px = px-3 do nav + px-3 do item + ícone de 20px + px-3: ícones, botão e
 * avatar ficam no mesmo x recolhido ou aberto, então nada pula sob o mouse.
 */
export function Sidebar({ defaultCollapsed }: { defaultCollapsed: boolean }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [peek, setPeek] = useState(false);
  const expanded = !collapsed || peek;
  const hideWhenNarrow = expanded ? "" : "md:hidden";

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <aside className={`shrink-0 border-b border-border bg-surface md:sticky md:top-0 md:z-30 md:h-dvh md:border-b-0 ${collapsed ? "md:w-[68px]" : "md:w-64"}`}>
      <div
        onMouseEnter={() => setPeek(true)}
        onMouseLeave={() => setPeek(false)}
        onFocus={() => setPeek(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPeek(false);
        }}
        className={`flex flex-col bg-surface md:absolute md:inset-y-0 md:left-0 md:overflow-hidden md:border-r md:border-border md:transition-[width] md:duration-150 ${expanded ? "md:w-64" : "md:w-[68px]"} ${collapsed && peek ? "md:shadow-2xl" : ""}`}
      >
        <div className="flex h-16 items-center gap-1 px-5 md:px-3">
          <button
            type="button"
            onClick={toggle}
            aria-pressed={!collapsed}
            aria-label={collapsed ? "Pin menu open" : "Collapse menu"}
            title={collapsed ? "Pin menu open" : "Collapse menu"}
            className="hidden shrink-0 items-center rounded-lg px-3 py-2 text-muted transition-colors hover:bg-foreground/5 hover:text-foreground md:flex"
          >
            <SidebarIcon className="size-5" />
          </button>
          <Link href="/" className={`flex items-center gap-0.5 whitespace-nowrap text-lg font-extrabold uppercase tracking-tight ${hideWhenNarrow}`}>
            <span>DayOne</span>
            <span className="text-accent">Pages</span>
          </Link>
        </div>

        <nav aria-label="Main menu" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:gap-4 md:overflow-y-auto md:pt-2">
          {navGroups.map((group, gi) => (
            <div key={group.title ?? gi} className="shrink-0">
              {group.title ? (
                <p className={`hidden whitespace-nowrap px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70 ${expanded ? "md:block" : ""}`}>
                  {group.title}
                </p>
              ) : null}
              <ul className="flex gap-1 md:flex-col">
                {group.items.map((item) => {
                  const active = !item.soon && isActive(pathname, item.href);
                  const Icon = item.icon;
                  const content = (
                    <>
                      <Icon className="size-5 shrink-0" />
                      <span className={`truncate ${hideWhenNarrow}`}>{item.label}</span>
                      {item.soon ? (
                        <span className={`ml-auto hidden rounded-md bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium text-muted ${expanded ? "md:inline" : ""}`}>
                          Soon
                        </span>
                      ) : null}
                    </>
                  );
                  const base = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors";

                  if (item.soon) {
                    return (
                      <li key={item.href} className="shrink-0">
                        <span
                          aria-disabled
                          title="Coming soon"
                          className={`${base} cursor-not-allowed text-muted/50 md:cursor-default`}
                        >
                          {content}
                        </span>
                      </li>
                    );
                  }
                  return (
                    <li key={item.href} className="shrink-0">
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        aria-label={item.label}
                        className={`${base} ${active ? "bg-accent/10 text-accent" : "text-muted hover:bg-foreground/5 hover:text-foreground"}`}
                      >
                        {content}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="hidden border-t border-border p-3 md:block">
          <div className="flex items-center gap-3 rounded-lg px-1 py-1">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">
              D
            </span>
            <div className={`min-w-0 ${hideWhenNarrow}`}>
              <p className="truncate text-sm font-medium">DayOne Pages</p>
              <p className="truncate text-xs text-muted">Workspace</p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
