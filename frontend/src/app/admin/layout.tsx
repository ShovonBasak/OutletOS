"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/Brand";
import { UserMenu } from "@/components/UserMenu";
import { useAuth, useRequireRole } from "@/lib/auth";
import { ADMIN_NAV, ADMIN_MOBILE_TABS, mobileTabFor, titleFor, type MobileTab } from "./nav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { loading } = useRequireRole("ADMIN");
  const { logout } = useAuth();
  const pathname = usePathname();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center font-mono text-sm text-ink-soft">
        Loading…
      </div>
    );
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
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
        {/* Sidebar — every group always expanded, admin's nav is small enough
            that a collapsible accordion just hides content for no reason. */}
        <aside className="sidebar hidden md:flex">
          <div className="sidebrand">
            <span className="inline-block h-3.5 w-3.5 flex-shrink-0 rounded-full bg-red" />
            <span className="font-display text-[13px] font-bold text-gold">CP FIVE STAR — Admin</span>
          </div>
          <nav className="flex flex-1 flex-col overflow-y-auto">
            {ADMIN_NAV.map((g) => (
              <div key={g.group}>
                <div className="navparent" style={{ cursor: "default" }}>
                  <span>{g.group}</span>
                </div>
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
              </div>
            ))}
            <button onClick={logout} className="navitem mt-auto border-t border-white/[0.12]">
              Sign out
            </button>
          </nav>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="desktoptop hidden md:flex">
            <h1>{titleFor(pathname)}</h1>
            <div className="date">Platform admin</div>
          </div>
          <main className="flex-1 overflow-y-auto p-4 pb-24 md:p-6">{children}</main>
        </div>
      </div>

      {/* Mobile bottom tabs */}
      <nav className="fixed bottom-0 left-0 flex w-full border-t border-white/10 bg-chrome md:hidden"
           style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {ADMIN_MOBILE_TABS.map((t: MobileTab) => {
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
