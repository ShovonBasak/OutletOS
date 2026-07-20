"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { bdt, today } from "@/lib/format";
import type { Pnl } from "@/lib/types";

type Period = "today" | "week" | "month";

function rangeFor(period: Period): { start: string; end: string } {
  const end = today();
  const d = new Date();
  if (period === "today") return { start: end, end };
  if (period === "week") {
    d.setDate(d.getDate() - 6);
    return { start: d.toISOString().slice(0, 10), end };
  }
  return { start: end.slice(0, 8) + "01", end };
}

export default function PnlPage() {
  const [period, setPeriod] = useState<Period>("today");
  const [pnl, setPnl] = useState<Pnl | null>(null);

  useEffect(() => {
    const { start, end } = rangeFor(period);
    api<Pnl>(`/reports/pnl/?outlet=1&start=${start}&end=${end}`).then(setPnl);
  }, [period]);

  return (
    <div className="flex flex-col gap-4">
      <div className="filterbar">
        <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
        </select>
      </div>

      {pnl && (
        <table className="ledger max-w-[520px]">
          <tbody>
            <tr>
              <td>Revenue (net of commission &amp; promos)</td>
              <td>{bdt(pnl.revenue)}</td>
            </tr>
            <tr>
              <td>COGS (recipe cost of units sold)</td>
              <td className="neg">− {bdt(pnl.cogs)}</td>
            </tr>
            <tr className="subtotal">
              <td>Gross profit</td>
              <td>{bdt(pnl.gross_profit)}</td>
            </tr>
            <tr className="section">
              <td colSpan={2}>Losses</td>
            </tr>
            <tr>
              <td>Wastage (made but not sold)</td>
              <td className="neg">− {bdt(pnl.wastage_cost)}</td>
            </tr>
            <tr>
              <td>Shrinkage (day-start ingredient loss)</td>
              <td className="neg">− {bdt(pnl.shrinkage_cost)}</td>
            </tr>
            <tr>
              <td>Packaging &amp; supplies (separate line)</td>
              <td>{bdt(pnl.packaging_cost)}</td>
            </tr>
            <tr className="section">
              <td colSpan={2}>Costs</td>
            </tr>
            <tr>
              <td>Fixed (rent + salary, daily share)</td>
              <td className="neg">− {bdt(pnl.fixed_costs)}</td>
            </tr>
            <tr>
              <td>Variable (gas, oil)</td>
              <td className="neg">− {bdt(pnl.variable_costs)}</td>
            </tr>
            <tr>
              <td>Adhoc (repairs)</td>
              <td className="neg">− {bdt(pnl.adhoc_costs)}</td>
            </tr>
            <tr className="net">
              <td>Net profit</td>
              <td className="pos">{bdt(pnl.net_profit)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
