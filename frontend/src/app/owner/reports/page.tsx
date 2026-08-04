"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { bdt } from "@/lib/format";
import type {
  ChannelBreakdownRow,
  DailyTrendRow,
  Pnl,
  ProductPerformanceRow,
  StockValueReport,
} from "@/lib/types";

// Default to current month
function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

function pct(val: string | number) {
  return `${Number(val).toFixed(1)}%`;
}
function num(val: string | number) {
  return Number(val).toLocaleString("en-BD");
}

type SortDir = "asc" | "desc";
type ProdCol = "units_sold" | "net_revenue" | "cogs" | "gross_profit" | "margin_pct";

export default function ReportsPage() {
  const [start, setStart] = useState(monthStart());
  const [end, setEnd] = useState(today());
  const [loading, setLoading] = useState(false);

  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [products, setProducts] = useState<ProductPerformanceRow[]>([]);
  const [channels, setChannels] = useState<ChannelBreakdownRow[]>([]);
  const [stock, setStock] = useState<StockValueReport | null>(null);
  const [trend, setTrend] = useState<DailyTrendRow[]>([]);

  const [sortCol, setSortCol] = useState<ProdCol>("net_revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [catFilter, setCatFilter] = useState("All");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const base = `outlet=1&start=${start}&end=${end}`;
      const [p, prod, ch, tr] = await Promise.all([
        api<Pnl>(`/reports/pnl/?${base}`),
        api<{ rows: ProductPerformanceRow[] }>(`/reports/product-performance/?${base}`),
        api<{ rows: ChannelBreakdownRow[] }>(`/reports/channel-breakdown/?${base}`),
        api<{ rows: DailyTrendRow[] }>(`/reports/daily-trend/?${base}`),
      ]);
      setPnl(p);
      setProducts(prod.rows);
      setChannels(ch.rows);
      setTrend(tr.rows);
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  // Stock value doesn't need date range
  useEffect(() => {
    api<StockValueReport>("/reports/stock-value/?outlet=1").then(setStock);
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleSort(col: ProdCol) {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  const categories = ["All", ...Array.from(new Set(products.map((p) => p.category))).sort()];

  const visibleProducts = [...products]
    .filter((p) => catFilter === "All" || p.category === catFilter)
    .sort((a, b) => {
      const av = Number(a[sortCol]);
      const bv = Number(b[sortCol]);
      return sortDir === "desc" ? bv - av : av - bv;
    });

  const indicator = (col: ProdCol) => (sortCol === col ? (sortDir === "desc" ? " ↓" : " ↑") : "");

  const profitColor = pnl
    ? Number(pnl.net_profit) >= 0 ? "text-leaf-deep" : "text-chili"
    : "text-ink";

  const grossMargin = pnl && Number(pnl.revenue) > 0
    ? (Number(pnl.gross_profit) / Number(pnl.revenue) * 100).toFixed(1)
    : "—";

  const cogsRatio = pnl && Number(pnl.revenue) > 0
    ? (Number(pnl.cogs) / Number(pnl.revenue) * 100).toFixed(1)
    : "—";

  const maxRevenue = Math.max(...trend.map((r) => Number(r.revenue)), 1);

  return (
    <div className="flex flex-col gap-6">
      {/* Header + date range */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold">Reports</h1>
          <p className="text-xs text-ink-soft">Accrual basis · Recipe-based COGS</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className="field-input !py-1 !text-xs" value={start}
            onChange={(e) => setStart(e.target.value)} />
          <span className="font-mono text-xs text-ink-soft">→</span>
          <input type="date" className="field-input !py-1 !text-xs" value={end}
            onChange={(e) => setEnd(e.target.value)} />
          <button className="btn btn-primary !py-1 !px-3 !text-xs" onClick={load} disabled={loading}>
            {loading ? "…" : "Go"}
          </button>
        </div>
      </div>

      {/* ── P&L summary cards ── */}
      {pnl && (
        <section className="flex flex-col gap-3">
          <h2 className="sec">Profit & Loss</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label="Revenue (net)" value={bdt(pnl.revenue)} />
            <StatCard label="COGS" value={bdt(pnl.cogs)} sub={`${cogsRatio}% of rev`} accent="neg" />
            <StatCard label="Gross profit" value={bdt(pnl.gross_profit)} sub={`${grossMargin}% margin`} />
            <StatCard label="Net profit" value={bdt(pnl.net_profit)} accent={Number(pnl.net_profit) >= 0 ? "pos" : "neg"} />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label="Wastage" value={bdt(pnl.wastage_cost)} accent="neg" />
            <StatCard label="Shrinkage" value={bdt(pnl.shrinkage_cost)} accent="neg" />
            <StatCard label="Fixed costs" value={bdt(pnl.fixed_costs)} accent="neg" />
            <StatCard label="Variable + adhoc" value={bdt(String(Number(pnl.variable_costs) + Number(pnl.adhoc_costs)))} accent="neg" />
          </div>

          <table className="ledger max-w-[480px]">
            <tbody>
              <tr><td>Revenue</td><td>{bdt(pnl.revenue)}</td></tr>
              <tr><td>Cost of goods sold</td><td className="neg">− {bdt(pnl.cogs)}</td></tr>
              <tr className="subtotal"><td>Gross profit ({grossMargin}%)</td><td>{bdt(pnl.gross_profit)}</td></tr>
              <tr><td>Wastage</td><td className="neg">− {bdt(pnl.wastage_cost)}</td></tr>
              <tr><td>Shrinkage</td><td className="neg">− {bdt(pnl.shrinkage_cost)}</td></tr>
              <tr><td>Fixed costs</td><td className="neg">− {bdt(pnl.fixed_costs)}</td></tr>
              <tr><td>Variable costs</td><td className="neg">− {bdt(pnl.variable_costs)}</td></tr>
              <tr><td>Adhoc costs</td><td className="neg">− {bdt(pnl.adhoc_costs)}</td></tr>
              {Number(pnl.other_income) > 0 && (
                <tr><td>Other income</td><td className="pos">+ {bdt(pnl.other_income)}</td></tr>
              )}
              <tr className="net">
                <td>Net profit</td>
                <td className={profitColor}>{bdt(pnl.net_profit)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* ── Channel breakdown ── */}
      {channels.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="sec">Revenue by channel</h2>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[520px]">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="text-right">Units sold</th>
                  <th className="text-right">Gross revenue</th>
                  <th className="text-right">Commission</th>
                  <th className="text-right">Discounts</th>
                  <th className="text-right">Net revenue</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const totalNet = channels.reduce((s, c) => s + Number(c.net_revenue), 0);
                  return channels.map((c) => (
                    <tr key={c.channel_id}>
                      <td className="font-medium">{c.channel_name}</td>
                      <td className="text-right font-mono">{num(c.units_sold)}</td>
                      <td className="text-right font-mono">{bdt(c.gross_revenue)}</td>
                      <td className="text-right font-mono text-chili">
                        {Number(c.commission) > 0 ? `− ${bdt(c.commission)}` : "—"}
                      </td>
                      <td className="text-right font-mono text-chili">
                        {Number(c.discount) > 0 ? `− ${bdt(c.discount)}` : "—"}
                      </td>
                      <td className="text-right font-mono font-semibold">{bdt(c.net_revenue)}</td>
                      <td className="text-right font-mono text-ink-soft">
                        {totalNet > 0 ? pct(Number(c.net_revenue) / totalNet * 100) : "—"}
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Product performance ── */}
      {products.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="sec">Product performance</h2>
            <div className="flex flex-wrap gap-1 ml-auto">
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCatFilter(c)}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] border ${
                    catFilter === c
                      ? "bg-action border-action text-gold"
                      : "border-[#d8cdb0] text-ink-soft"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[640px]">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th className="cursor-pointer text-right select-none" onClick={() => toggleSort("units_sold")}>
                    Units{indicator("units_sold")}
                  </th>
                  <th className="cursor-pointer text-right select-none" onClick={() => toggleSort("net_revenue")}>
                    Net revenue{indicator("net_revenue")}
                  </th>
                  <th className="cursor-pointer text-right select-none" onClick={() => toggleSort("cogs")}>
                    COGS{indicator("cogs")}
                  </th>
                  <th className="cursor-pointer text-right select-none" onClick={() => toggleSort("gross_profit")}>
                    Gross profit{indicator("gross_profit")}
                  </th>
                  <th className="cursor-pointer text-right select-none" onClick={() => toggleSort("margin_pct")}>
                    Margin{indicator("margin_pct")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((p) => {
                  const margin = Number(p.margin_pct);
                  const marginColor = margin >= 30 ? "text-leaf-deep" : margin >= 15 ? "text-gold-deep" : "text-chili";
                  return (
                    <tr key={p.product_id}>
                      <td className="font-medium">{p.product_name}</td>
                      <td className="font-mono text-[10px] text-ink-soft">{p.category}</td>
                      <td className="text-right font-mono">{num(p.units_sold)}</td>
                      <td className="text-right font-mono">{bdt(p.net_revenue)}</td>
                      <td className="text-right font-mono text-ink-soft">{bdt(p.cogs)}</td>
                      <td className="text-right font-mono">{bdt(p.gross_profit)}</td>
                      <td className={`text-right font-mono font-semibold ${marginColor}`}>
                        {pct(p.margin_pct)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Daily revenue trend ── */}
      {trend.length > 1 && (
        <section className="flex flex-col gap-2">
          <h2 className="sec">Daily revenue trend</h2>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[420px]">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="text-right">Units sold</th>
                  <th className="text-right">Revenue</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {trend.map((row) => {
                  const barW = Math.round((Number(row.revenue) / maxRevenue) * 100);
                  return (
                    <tr key={row.date}>
                      <td className="font-mono text-xs">{row.date}</td>
                      <td className="text-right font-mono text-xs">{num(row.units_sold)}</td>
                      <td className="text-right font-mono text-xs font-medium">{bdt(row.revenue)}</td>
                      <td className="w-32 pl-2">
                        <div className="h-2 rounded-full bg-paper-dim">
                          <div className="h-2 rounded-full bg-action" style={{ width: `${barW}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Stock on hand ── */}
      {stock && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="sec">Raw stock on hand (current)</h2>
            <p className="font-mono text-[11px] font-semibold text-ink">
              Total: {bdt(stock.total_value)}
            </p>
          </div>
          <p className="text-xs text-ink-soft">
            Ingredients currently in storage, valued at latest pack cost ÷ pieces per pack.
            This is inventory you've already paid for but not yet sold.
          </p>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[480px]">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th className="text-right">Qty on hand</th>
                  <th className="text-right">Cost / unit</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {stock.rows.map((r) => (
                  <tr key={r.ingredient_id}>
                    <td>
                      <p className="font-medium leading-tight">{r.display_name}</p>
                      {r.display_name !== r.ingredient_name && (
                        <p className="font-mono text-[9px] text-ink-soft/50">{r.ingredient_name}</p>
                      )}
                    </td>
                    <td className="text-right font-mono text-xs">
                      {num(r.quantity)} {r.base_unit}
                    </td>
                    <td className="text-right font-mono text-xs text-ink-soft">৳{r.cost_per_unit}</td>
                    <td className="text-right font-mono text-xs font-semibold">{bdt(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({
  label, value, sub, accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "pos" | "neg";
}) {
  const valColor = accent === "pos" ? "text-leaf-deep" : accent === "neg" ? "text-chili" : "text-ink";
  return (
    <div className="rounded border border-[#d8cdb0] bg-paper px-3 py-2.5">
      <p className="font-mono text-[10px] text-ink-soft">{label}</p>
      <p className={`font-mono text-[15px] font-bold leading-tight ${valColor}`}>{value}</p>
      {sub && <p className="font-mono text-[10px] text-ink-soft/70">{sub}</p>}
    </div>
  );
}
