"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "@/components/Brand";
import { useAuth, useRequireRole } from "@/lib/auth";
import { getTodayOperatingDay } from "@/lib/operatingDay";
import { OperatingDayContext } from "@/lib/staffDay";
import { today } from "@/lib/format";
import type { OperatingDay } from "@/lib/types";

const TABS = [
  { href: "/staff", label: "Home", gate: "always" as const },
  { href: "/staff/stock-in", label: "Stock In", gate: "stock" as const },
  { href: "/staff/prep", label: "Prep log", gate: "full" as const },
  { href: "/staff/closing", label: "Closing", gate: "closing" as const },
];

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const { loading } = useRequireRole("STAFF");
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const outlet = user?.outlet ?? 1;
  const [day, setDay] = useState<OperatingDay | null>(null);
  const [workDate, _setWorkDate] = useState(today());
  const workDateRef = useRef(workDate);

  async function refreshDay() {
    if (!user) return;
    try {
      setDay(await getTodayOperatingDay(outlet, workDateRef.current));
    } catch {
      /* ignore — home still renders */
    }
  }

  function setWorkDate(d: string) {
    workDateRef.current = d;
    _setWorkDate(d);
    if (user) {
      getTodayOperatingDay(outlet, d).then(setDay).catch(() => {});
    }
  }

  useEffect(() => {
    refreshDay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, outlet]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center font-mono text-sm text-ink-soft">
        Loading…
      </div>
    );
  }

  const isActive = (href: string) =>
    href === "/staff" ? pathname === "/staff" : pathname.startsWith(href);

  const isUnlocked = (gate: "always" | "stock" | "full" | "closing") => {
    if (gate === "always") return true;
    if (!day) return false;
    if (gate === "stock") return day.stock_in_unlocked;
    if (gate === "closing") return day.full_unlocked || day.status === "CLOSED";
    return day.full_unlocked;
  };

  return (
    <OperatingDayContext.Provider value={{ day, refreshDay, workDate, setWorkDate }}>
      <div className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col bg-paper shadow-xl">
        <header className="flex items-center justify-between bg-chrome px-4 py-3.5 text-paper">
          <Brand />
          <button
            onClick={logout}
            className="rounded-full border border-white/20 px-2.5 py-1 font-mono text-[10px] text-white/70"
          >
            STAFF · exit
          </button>
        </header>

        <main className="flex-1 overflow-y-auto p-4 pb-24">{children}</main>

        <nav className="fixed bottom-0 left-1/2 flex w-full max-w-[420px] -translate-x-1/2 border-t border-white/10 bg-chrome">
          {TABS.map((t) => {
            const unlocked = isUnlocked(t.gate);
            const cls = `flex-1 py-3.5 text-center font-mono text-[10px] uppercase tracking-wide ${
              isActive(t.href) ? "text-gold" : unlocked ? "text-white/50" : "text-white/25"
            }`;
            return unlocked ? (
              <Link key={t.href} href={t.href} className={cls}>
                {t.label}
              </Link>
            ) : (
              <span key={t.href} className={cls} title="Finish day-start steps first">
                🔒 {t.label}
              </span>
            );
          })}
        </nav>
      </div>
    </OperatingDayContext.Provider>
  );
}
