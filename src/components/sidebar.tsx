"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navGroups } from "@/lib/navigation";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex shrink-0 flex-col border-b border-border bg-surface md:sticky md:top-0 md:h-dvh md:w-64 md:border-b-0 md:border-r">
      <div className="flex h-16 items-center px-5">
        <Link href="/" className="flex items-center gap-0.5 text-lg font-extrabold uppercase tracking-tight">
          <span>DayOne</span>
          <span className="text-accent">Pages</span>
        </Link>
      </div>

      <nav aria-label="Main menu" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:gap-4 md:overflow-y-auto md:pt-2">
        {navGroups.map((group, gi) => (
          <div key={group.title ?? gi} className="shrink-0">
            {group.title ? (
              <p className="hidden px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70 md:block">
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
                    <span className="truncate">{item.label}</span>
                    {item.soon ? (
                      <span className="ml-auto hidden rounded-md bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium text-muted md:inline">
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
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">DayOne Pages</p>
            <p className="truncate text-xs text-muted">Workspace</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
