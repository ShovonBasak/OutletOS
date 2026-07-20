"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { bdt, today } from "@/lib/format";
import type { DailyClosing, Paginated } from "@/lib/types";

const CHANNEL_ORDER = ["Foodpanda", "Foodi", "Pathao", "Walk-in"];

interface ProductAgg {
  product: string;
  perChannel: Record<string, number>;
  totalPcs: number;
  netRevenue: number;
}

export default function SalesReportPage() {
  const weekAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  })();
  const [start, setStart] = useState(weekAgo);
  const [end, setEnd] = useState(today());
  const [channel, setChannel] = useState("");
  const [search, setSearch] = useState("");
  const [closings, setClosings] = useState<DailyClosing[]>([]);

  useEffect(() => {
    api<Paginated<DailyClosing>>("/daily-closings/?outlet=1").then((d) => setClosings(d.results));
  }, []);

  const agg = useMemo(() => {
    const map = new Map<string, ProductAgg>();
    for (const c of closings) {
      if (c.closing_date < start || c.closing_date > end) continue;
      for (const line of c.sales_lines) {
        if (channel && line.channel_name !== channel) continue;
        let row = map.get(line.product_name);
        if (!row) {
          row = { product: line.product_name, perChannel: {}, totalPcs: 0, netRevenue: 0 };
          map.set(line.product_name, row);
        }
        row.perChannel[line.channel_name] = (row.perChannel[line.channel_name] ?? 0) + line.quantity_sold;
        row.totalPcs += line.quantity_sold;
        row.netRevenue += Number(line.net_amount);
      }
    }
    return [...map.values()].sort((a, b) => b.netRevenue - a.netRevenue);
  }, [closings, start, end, channel]);

  const rows = agg.filter((r) => (search ? r.product.toLowerCase().includes(search.toLowerCase()) : true));
  const columns = channel ? [channel] : CHANNEL_ORDER;

  return (
    <div className="flex flex-col gap-4">
      <div className="filterbar">
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="text-xs text-ink-soft">to</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          {CHANNEL_ORDER.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input placeholder="Search menu items…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[680px]">
          <thead>
            <tr>
              <th>Product</th>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
              <th>Total pcs</th>
              <th>Net revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product}>
                <td>{r.product}</td>
                {columns.map((c) => (
                  <td key={c}>{r.perChannel[c] ?? 0}</td>
                ))}
                <td>{r.totalPcs}</td>
                <td>{bdt(r.netRevenue)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 3} className="text-ink-soft">
                  No sales in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-soft">Net revenue reflects channel-specific promo pricing, aggregated across closings.</p>
    </div>
  );
}
