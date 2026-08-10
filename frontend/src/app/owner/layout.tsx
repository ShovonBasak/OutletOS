"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Brand } from "@/components/Brand";
import { useAuth, useRequireRole } from "@/lib/auth";
import {
  OWNER_NAV,
  OWNER_MOBILE_TABS,
  activeGroupFor,
  mobileTabFor,
  titleFor,
} from "./nav";

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  const { loading } = useRequireRole("OWNER");
  const { user, logout } = useAuth();
  const pathname = usePathname();

  // Collapsible accordion: groups start collapsed, the active group auto-opens.
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const active = activeGroupFor(pathname);
    if (active) setOpen((prev) => new Set(prev).add(active));
  }, [pathname]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center font-mono text-sm text-ink-soft">
        Loading…
      </div>
    );
  }

  const isActive = (href: string) =>
    href === "/owner"
      ? pathname === "/owner"
      : pathname === href || pathname.startsWith(href + "/");

  const toggle = (group: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  const activeMobileTab = mobileTabFor(pathname);

  return (
    <div className="flex min-h-screen flex-col bg-paper-dim md:items-center md:py-8">
      {/* Mobile top bar */}
      <header className="flex items-center justify-between bg-chrome px-4 py-3.5 text-paper md:hidden">
        <Brand />
        <button onClick={logout} className="rounded-full border border-white/20 px-2.5 py-1 font-mono text-[10px] text-white/70">
          OWNER · exit
        </button>
      </header>

      {/* Desktop shell card — mirrors the sitemap's .desktop layout */}
      <div className="desktop max-w-[960px]">
        {/* Grouped, collapsible sidebar (accordion) */}
        <aside className="sidebar hidden md:flex">
          <div className="sidebrand">
            <span className="inline-block h-3.5 w-3.5 flex-shrink-0 rounded-full bg-red" />
            <span className="font-display text-[13px] font-bold text-gold">{user?.outlet_name ?? "CP FIVE STAR"}</span>
          </div>
          <nav className="flex flex-1 flex-col overflow-y-auto">
            {OWNER_NAV.map((g) =>
              g.group === "Overview" ? (
                // Dashboard is a plain top-level link, not a collapsible group.
                g.items.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`navitem block !pl-4 ${isActive(n.href) ? "active" : ""}`}
                  >
                    {n.label}
                  </Link>
                ))
              ) : (
                <div key={g.group}>
                  <button
                    type="button"
                    aria-expanded={open.has(g.group)}
                    onClick={() => toggle(g.group)}
                    className="navparent"
                  >
                    <span>{g.group}</span>
                    <span className={`navchev ${open.has(g.group) ? "open" : ""}`}>▸</span>
                  </button>
                  {open.has(g.group) && (
                    <div className="navchildren">
                      {g.items.map((n) => (
                        <Link
                          key={n.href}
                          href={n.href}
                          className={`navitem block ${isActive(n.href) ? "active" : ""}`}
                        >
                          {n.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )
            )}
            <button onClick={logout} className="navitem mt-auto border-t border-white/[0.12]">
              Sign out
            </button>
          </nav>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="desktoptop hidden md:flex">
            <h1>{titleFor(pathname)}</h1>
            <div className="date">{user?.outlet_name ?? "Outlet"}</div>
          </div>
          <main className="flex-1 overflow-y-auto p-4 pb-24 md:p-6">{children}</main>
        </div>
      </div>

      {/* Mobile bottom tabs — each opens a hub screen */}
      <nav className="fixed bottom-0 left-0 flex w-full border-t border-white/10 bg-chrome md:hidden">
        {OWNER_MOBILE_TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`flex-1 py-3.5 text-center font-mono text-[10px] uppercase tracking-wide ${
              activeMobileTab === t.href ? "text-gold" : "text-white/50"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
