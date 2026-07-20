"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

const TILES = [
  { href: "/owner/expenses", icon: "৳", label: "Expenses" },
  { href: "/owner/products", icon: "≡", label: "Products & recipes" },
  { href: "/owner/team", icon: "◈", label: "Team & outlets" },
  { href: "/owner/settings", icon: "⚙", label: "Settings & promos" },
  { href: "/owner/setup", icon: "🧩", label: "Setup (ingredients & recipes)" },
];

export default function MoreHub() {
  const { logout } = useAuth();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">More</h1>
        <p className="text-xs text-ink-soft">Manage catalog, team & setup</p>
      </div>

      <div className="tilegrid">
        {TILES.map((t) => (
          <Link key={t.href} href={t.href} className="tile">
            <span className="n">{t.icon}</span>
            <span className="l">{t.label}</span>
          </Link>
        ))}
      </div>

      <button className="btn btn-ghost" onClick={logout}>
        Log out
      </button>
    </div>
  );
}
