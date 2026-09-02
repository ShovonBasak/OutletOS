"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Brand } from "@/components/Brand";
import { UserMenu } from "@/components/UserMenu";
import { useAuth, useRequireRole } from "@/lib/auth";
import {
  navFor,
  OWNER_MOBILE_TABS,
  activeGroupFor,
  mobileTabFor,
  titleFor,
  type MobileTab,
} from "./nav";

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  const { loading, isAdmin } = useRequireRole(["OWNER", "ADMIN"]);
  const { user, logout } = useAuth();
  const pathname = usePathname();

  const nav = navFor(isAdmin);

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
    setOpen((prev) => (prev.has(group) ? new Set() : new Set([group])));

  const activeMobileTab = mobileTabFor(pathname);

  return (
    <div className="flex min-h-screen flex-col bg-paper-dim md:items-center md:py-8">
      {/* Mobile top bar */}
      <header className="flex items-center justify-between bg-chrome px-4 py-3.5 text-paper md:hidden">
        <Brand />
        <UserMenu />
      </header>

      {/* Desktop shell card */}
      <div className="desktop max-w-[960px]">
        {/* Grouped, collapsible sidebar (accordion) */}
        <aside className="sidebar hidden md:flex">
          <div className="sidebrand">
            <span className="inline-block h-3.5 w-3.5 flex-shrink-0 rounded-full bg-red" />
            <span className="font-display text-[13px] font-bold text-gold">{user?.outlet_name ?? "CP FIVE STAR"}</span>
          </div>
          <nav className="flex flex-1 flex-col overflow-y-auto">
            {nav.map((g) =>
              g.group === "Overview" ? (
                // Overview items are plain top-level links, not collapsible.
                g.items.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`navitem toplevel block ${isActive(n.href) ? "active" : ""}`}
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

      {/* Mobile bottom tabs */}
      <nav className="fixed bottom-0 left-0 flex w-full border-t border-white/10 bg-chrome md:hidden"
           style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {OWNER_MOBILE_TABS.map((t: MobileTab) => {
          const active = activeMobileTab === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-3 min-h-[56px] transition-colors ${
                active ? "text-gold" : "text-white/50"
              }`}
            >
              <span className={`text-[18px] leading-none ${active ? "text-gold" : "text-white/60"}`}>
                {t.icon}
              </span>
              <span className={`font-mono text-[9px] uppercase tracking-widest ${active ? "text-gold" : "text-white/40"}`}>
                {t.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
