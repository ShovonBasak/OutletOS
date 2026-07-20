"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { bdt, today } from "@/lib/format";
import type { PackagingReport } from "@/lib/types";

type Period = "week" | "month";

function rangeFor(period: Period): { start: string; end: string } {
  const end = today();
  if (period === "week") {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return { start: d.toISOString().slice(0, 10), end };
  }
  return { start: end.slice(0, 8) + "01", end };
}

export default function PackagingReportPage() {
  const [period, setPeriod] = useState<Period>("month");
  const [report, setReport] = useState<PackagingReport | null>(null);

  useEffect(() => {
    const { start, end } = rangeFor(period);
    api<PackagingReport>(`/reports/packaging/?outlet=1&start=${start}&end=${end}`).then(setReport);
  }, [period]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Packaging &amp; supplies report</h1>
        <p className="text-xs text-ink-soft">
          Consumption per 100 products sold. A spike above an item&apos;s own baseline is a signal
          to investigate — period-level data can flag it, not prove a cause.
        </p>
      </div>

      <div className="filterbar">
        <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          <option value="week">This week</option>
          <option value="month">This month</option>
        </select>
      </div>

      {report && (
        <>
          <p className="font-mono text-[11px] text-ink-soft">
            {report.total_units_sold} products sold in period.
          </p>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[560px]">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Consumed</th>
                  <th>Cost</th>
                  <th>Per 100 sold</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.ingredient}>
                    <td>{r.ingredient}</td>
                    <td>
                      {r.consumed} {r.base_unit}
                    </td>
                    <td>{bdt(r.cost)}</td>
                    <td className="font-mono">{r.consumption_ratio}</td>
                  </tr>
                ))}
                {report.rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-ink-soft">
                      No periodic counts recorded in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
