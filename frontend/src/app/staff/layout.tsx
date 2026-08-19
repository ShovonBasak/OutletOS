"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "@/components/Brand";
import { useAuth, useRequireRole } from "@/lib/auth";
import { api } from "@/lib/api";
import { getTodayOperatingDay, invalidateDayCache } from "@/lib/operatingDay";
import { OperatingDayContext } from "@/lib/staffDay";
import { today } from "@/lib/format";
import type { OperatingDay } from "@/lib/types";

const TABS = [
  { href: "/staff",          label: "Home",     icon: "⌂", gate: "always"  as const },
  { href: "/staff/stock-in", label: "Stock In", icon: "↓", gate: "stock"   as const },
  { href: "/staff/prep",     label: "Prep",     icon: "♨", gate: "full"    as const },
  { href: "/staff/closing",  label: "Closing",  icon: "✓", gate: "closing" as const },
];

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const { loading } = useRequireRole("STAFF");
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const outlet = user?.outlet ?? 1;
  const [day, setDay] = useState<OperatingDay | null>(null);
  const [workDate, _setWorkDate] = useState(today());
  const workDateRef = useRef(workDate);
  const prevLayoutCtx = useRef({ userId: 0, outlet: 0 });

  async function refreshDay() {
    if (!user) return;
    try {
      invalidateDayCache(outlet, workDateRef.current);
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
    if (!user) return;
    if (prevLayoutCtx.current.userId === user.id && prevLayoutCtx.current.outlet === outlet) return;
    prevLayoutCtx.current = { userId: user.id, outlet };
    // active-work-date gives a hint; getTodayOperatingDay may apply the day-boundary
    // guard and return a different date's OperatingDay. Always sync workDate to the
    // returned OperatingDay's actual date so every page fetches and saves consistently.
    api<{ date: string }>(`/daily-closings/active-work-date/?outlet=${outlet}`)
      .then(({ date }) => getTodayOperatingDay(outlet, date))
      .then((operatingDay) => {
        workDateRef.current = operatingDay.date;
        _setWorkDate(operatingDay.date);
        setDay(operatingDay);
      })
      .catch(() => refreshDay());
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
      <div className="flex min-h-screen w-full flex-col bg-paper">
        <header className="flex items-center justify-between bg-chrome px-4 py-3.5 text-paper">
          <Brand name={user?.outlet_name} />
          <button
            onClick={logout}
            className="rounded-full border border-white/20 px-2.5 py-1 font-mono text-[10px] text-white/70"
          >
            STAFF · exit
          </button>
        </header>

        <main className="flex-1 overflow-y-auto p-4 pb-24">{children}</main>

        <nav
          className="fixed bottom-0 left-0 flex w-full border-t border-white/10 bg-chrome"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {TABS.map((t) => {
            const unlocked = isUnlocked(t.gate);
            const active = isActive(t.href);
            const content = (
              <>
                <span className={`text-[18px] leading-none ${
                  active ? "text-gold" : unlocked ? "text-white/60" : "text-white/25"
                }`}>
                  {unlocked ? t.icon : "🔒"}
                </span>
                <span className={`font-mono text-[9px] uppercase tracking-widest ${
                  active ? "text-gold" : unlocked ? "text-white/40" : "text-white/20"
                }`}>
                  {t.label}
                </span>
              </>
            );
            return unlocked ? (
              <Link
                key={t.href}
                href={t.href}
                className="flex flex-1 flex-col items-center justify-center gap-0.5 py-3 min-h-[56px] transition-colors"
              >
                {content}
              </Link>
            ) : (
              <span
                key={t.href}
                className="flex flex-1 flex-col items-center justify-center gap-0.5 py-3 min-h-[56px] cursor-not-allowed"
                title="Finish day-start steps first"
              >
                {content}
              </span>
            );
          })}
        </nav>
      </div>
    </OperatingDayContext.Provider>
  );
}
