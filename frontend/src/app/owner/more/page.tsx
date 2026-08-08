"use client";

import Link from "next/link";

const TILES = [
  { href: "/owner/accounts", icon: "⇌", label: "Accounts" },
  { href: "/owner/expenses", icon: "৳", label: "Expenses" },
  { href: "/owner/other-income", icon: "+৳", label: "Other income" },
  { href: "/owner/products", icon: "≡", label: "Products & recipes" },
  { href: "/owner/team", icon: "◈", label: "Team & outlets" },
  { href: "/owner/settings", icon: "⚙", label: "Settings & promos" },
  { href: "/owner/setup", icon: "🧩", label: "Setup (ingredients & recipes)" },
  { href: "/owner/profile", icon: "◉", label: "Profile & password" },
];

export default function MoreHub() {
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
    </div>
  );
}
