"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { navigation } from "@/lib/navigation";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ footer }: { footer?: ReactNode }) {
  const pathname = usePathname();

  return (
    <aside className="flex shrink-0 flex-col border-b border-border bg-surface md:sticky md:top-0 md:h-dvh md:w-64 md:border-b-0 md:border-r">
      <div className="flex h-16 items-center px-5">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-accent text-sm text-accent-foreground">
            D
          </span>
          DayOne Pages
        </Link>
      </div>

      <nav aria-label="Menu principal" className="px-3 pb-3 md:flex-1 md:pt-2">
        <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {navigation.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href} className="shrink-0">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-accent/10 text-accent"
                      : "text-muted hover:bg-foreground/5 hover:text-foreground",
                  ].join(" ")}
                >
                  <Icon className="size-5" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {footer ? <div className="border-t border-border px-3 py-3">{footer}</div> : null}
    </aside>
  );
}
