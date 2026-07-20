"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { bdt, today } from "@/lib/format";
import type { Pnl } from "@/lib/types";

const TILES = [
  { href: "/owner/sales", icon: "→", label: "Full sales report" },
  { href: "/owner/settlements", icon: "→", label: "Settlements" },
  { href: "/owner/pnl", icon: "≣", label: "Profit & loss detail" },
  { href: "/owner/packaging", icon: "📦", label: "Packaging & supplies" },
];

export default function ReportsHub() {
  const [pnl, setPnl] = useState<Pnl | null>(null);

  useEffect(() => {
    const t = today();
    api<Pnl>(`/reports/pnl/?outlet=1&start=${t}&end=${t}`).then(setPnl);
  }, []);

  const losses = pnl
    ? Number(pnl.wastage_cost) + Number(pnl.shrinkage_cost)
    : 0;
  const overhead = pnl
    ? Number(pnl.fixed_costs) + Number(pnl.variable_costs) + Number(pnl.adhoc_costs)
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Reports</h1>
        <p className="text-xs text-ink-soft">Today, accrual basis</p>
      </div>

      {pnl && (
        <table className="ledger max-w-[520px]">
          <tbody>
            <tr>
              <td>Revenue (net)</td>
              <td>{bdt(pnl.revenue)}</td>
            </tr>
            <tr>
              <td>COGS</td>
              <td className="neg">− {bdt(pnl.cogs)}</td>
            </tr>
            <tr className="subtotal">
              <td>Gross profit</td>
              <td>{bdt(pnl.gross_profit)}</td>
            </tr>
            <tr>
              <td>Wastage + Shrinkage</td>
              <td className="neg">− {bdt(losses)}</td>
            </tr>
            <tr>
              <td>Fixed + variable + adhoc</td>
              <td className="neg">− {bdt(overhead)}</td>
            </tr>
            <tr className="net">
              <td>Net profit</td>
              <td className="pos">{bdt(pnl.net_profit)}</td>
            </tr>
          </tbody>
        </table>
      )}

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
