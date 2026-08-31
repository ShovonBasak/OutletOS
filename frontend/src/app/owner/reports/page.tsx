"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { bdt, today } from "@/lib/format";
import type {
  ChannelBreakdownRow,
  DailyTrendRow,
  Pnl,
  ProductPerformanceRow,
  ProductPerformanceResponse,
  PurchaseSummary,
  ShrinkageDetail,
  StockValueReport,
} from "@/lib/types";

// ─── Date presets ─────────────────────────────────────────────────────────────
type Preset = "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "custom";

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }

function rangeFor(preset: Preset, customStart: string, customEnd: string) {
  const now = new Date();
  const end = today();
  if (preset === "today") return { start: end, end };
  if (preset === "yesterday") {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const s = isoDate(y); return { start: s, end: s };
  }
  if (preset === "this_week") {
    const d = new Date(now); d.setDate(d.getDate() - 6);
    return { start: isoDate(d), end };
  }
  if (preset === "this_month") return { start: end.slice(0, 8) + "01", end };
  if (preset === "last_month") {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: isoDate(d), end: isoDate(last) };
  }
  return { start: customStart, end: customEnd };
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "7 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom" },
];

function pct(val: number) { return `${val.toFixed(1)}%`; }
function num(val: string | number) { return Number(val).toLocaleString("en-BD"); }

type SortDir = "asc" | "desc";
type ProdCol = "units_sold" | "gross_revenue" | "cogs" | "gross_profit" | "margin_pct";

export default function ReportsPage() {
  const [preset, setPreset] = useState<Preset>("this_month");
  const [customStart, setCustomStart] = useState(today().slice(0, 8) + "01");
  const [customEnd, setCustomEnd] = useState(today());
  const [loading, setLoading] = useState(false);
  const [showInvoices, setShowInvoices] = useState(false);
  const [showStockDetail, setShowStockDetail] = useState(false);
  const [showShrinkage, setShowShrinkage] = useState(false);

  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [products, setProducts] = useState<ProductPerformanceRow[]>([]);
  const [productTotalCount, setProductTotalCount] = useState(0);
  const [allProducts, setAllProducts] = useState<ProductPerformanceRow[] | null>(null);
  const [prodExpanded, setProdExpanded] = useState(false);
  const [prodExpandLoading, setProdExpandLoading] = useState(false);
  const [channels, setChannels] = useState<ChannelBreakdownRow[]>([]);
  const [stock, setStock] = useState<StockValueReport | null>(null);
  const [trend, setTrend] = useState<DailyTrendRow[]>([]);
  const [purchase, setPurchase] = useState<PurchaseSummary | null>(null);
  const [shrinkage, setShrinkage] = useState<ShrinkageDetail | null>(null);

  const [sortCol, setSortCol] = useState<ProdCol>("gross_revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { start, end } = rangeFor(preset, customStart, customEnd);

  const load = useCallback(async () => {
    setLoading(true);
    setShrinkage(null);
    setAllProducts(null);
    setProdExpanded(false);
    try {
      const q = `outlet=1&start=${start}&end=${end}`;
      const [p, prod, ch, tr, pur] = await Promise.all([
        api<Pnl>(`/reports/pnl/?${q}`),
        api<ProductPerformanceResponse>(`/reports/product-performance/?${q}&limit=5`),
        api<{ rows: ChannelBreakdownRow[] }>(`/reports/channel-breakdown/?${q}`),
        api<{ rows: DailyTrendRow[] }>(`/reports/daily-trend/?${q}`),
        api<PurchaseSummary>(`/reports/purchase-summary/?${q}`),
      ]);
      setPnl(p);
      setProducts(prod.rows);
      setProductTotalCount(prod.total_count);
      setChannels(ch.rows);
      setTrend(tr.rows);
      setPurchase(pur);
      // Load shrinkage separately so a failure here doesn't block the rest
      api<ShrinkageDetail>(`/reports/shrinkage-detail/?${q}`)
        .then(setShrinkage)
        .catch(() => setShrinkage({ start, end, total: "0", rows: [] }));
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  async function expandProducts() {
    if (allProducts) { setProdExpanded(true); return; }
    setProdExpandLoading(true);
    try {
      const q = `outlet=1&start=${start}&end=${end}`;
      const res = await api<ProductPerformanceResponse>(`/reports/product-performance/?${q}`);
      setAllProducts(res.rows);
      setProdExpanded(true);
    } finally {
      setProdExpandLoading(false);
    }
  }

  // Stock value is always live — no date range
  useEffect(() => {
    api<StockValueReport>("/reports/stock-value/?outlet=1").then(setStock);
  }, []);

  useEffect(() => {
    if (preset !== "custom") load();
  }, [preset, load]);

  function toggleSort(col: ProdCol) {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  const ind = (col: ProdCol) => sortCol === col ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  // Derive walk-in vs online revenue using gross (actual sell value)
  const walkInCh = channels.find((c) => c.channel_name.toLowerCase().includes("walk"));
  const onlineChs = channels.filter((c) => !c.channel_name.toLowerCase().includes("walk"));
  const walkInRev = walkInCh ? Number(walkInCh.gross_revenue) : 0;
  const onlineRev = onlineChs.reduce((s, c) => s + Number(c.gross_revenue), 0);
  const totalRev = walkInRev + onlineRev;

  // Gross profit shown after deducting commission, COGS, packaging and all operating costs
  const displayGrossProfit = pnl
    ? Number(pnl.gross_profit)
      - Number(pnl.packaging_cost)
      - Number(pnl.fixed_costs)
      - Number(pnl.variable_costs)
      - Number(pnl.adhoc_costs)
    : null;
  const grossMargin = displayGrossProfit !== null && Number(pnl?.gross_revenue) > 0
    ? displayGrossProfit / Number(pnl!.gross_revenue) * 100
    : null;
  const cogsRatio = pnl && Number(pnl.gross_revenue) > 0
    ? Number(pnl.cogs) / Number(pnl.gross_revenue) * 100
    : null;
  const netProfit = pnl ? Number(pnl.net_profit) : null;
  const isProfit = netProfit !== null && netProfit >= 0;

  // Purchase vs COGS insight — gap = ingredients bought that didn't make it into sold products
  const purchaseTotal = purchase ? Number(purchase.total) : 0;
  const cogsTotal = pnl ? Number(pnl.cogs) : 0;
  const purchaseCogsGap = purchaseTotal > 0 && cogsTotal > 0 ? purchaseTotal - cogsTotal : null;

  const maxRevenue = Math.max(...trend.map((r) => Number(r.revenue)), 1);

  const displayedProducts = prodExpanded && allProducts ? allProducts : products;
  const visibleProducts = [...displayedProducts].sort((a, b) => {
    const av = Number(a[sortCol]);
    const bv = Number(b[sortCol]);
    return sortDir === "desc" ? bv - av : av - bv;
  });

  const rangeLabel = preset === "custom"
    ? `${customStart} → ${customEnd}`
    : `${start}${start !== end ? ` → ${end}` : ""}`;

  return (
    <div className="flex flex-col gap-6">

      {/* ── Header ── */}
      <div>
        <h1 className="font-display text-xl font-bold">Reports</h1>
        <p className="font-mono text-[11px] text-ink-soft">{rangeLabel} · accrual basis</p>
      </div>

      {/* ── Quick links to sub-report pages ── */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { href: "/owner/pnl",              label: "P&L statement" },
          { href: "/owner/sell-history",     label: "Sell history" },
          { href: "/owner/settlements",      label: "Settlements" },
          { href: "/owner/stock-in-history", label: "Stock in history" },
          { href: "/owner/packaging",        label: "Packaging" },
          { href: "/owner/stock",            label: "Stock levels" },
        ].map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="flex items-center justify-center rounded border border-[#d8cdb0] bg-paper px-2 py-2.5 text-center font-mono text-[10px] text-ink-soft leading-tight hover:border-action/40 hover:text-ink transition-colors"
          >
            {l.label}
          </Link>
        ))}
      </div>

      {/* ── Date presets ── */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPreset(p.value)}
            className={`rounded-full border px-3 py-1 font-mono text-[11px] transition-colors ${
              preset === p.value
                ? "border-action bg-action text-gold"
                : "border-[#d8cdb0] text-ink-soft hover:border-action/50"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom range inputs */}
      {preset === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" className="field-input !py-1 !text-xs" value={customStart}
            onChange={(e) => setCustomStart(e.target.value)} />
          <span className="font-mono text-xs text-ink-soft">→</span>
          <input type="date" className="field-input !py-1 !text-xs" value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)} />
          <button className="btn btn-primary !py-1 !px-3 !text-xs" disabled={loading} onClick={load}>
            {loading ? "…" : "Apply"}
          </button>
        </div>
      )}

      {loading && <p className="font-mono text-[11px] text-ink-soft">Loading…</p>}

      {/* ══════════════════════════════════════════════
          KPI CARDS
      ══════════════════════════════════════════════ */}
      {pnl && (
        <section className="flex flex-col gap-2">

          {/* Row 1 — Revenue split */}
          <div className="grid grid-cols-3 gap-2">
            <KpiCard
              label="Total revenue"
              value={bdt(pnl.gross_revenue)}
              sub={Number(pnl.commission_total) > 0 ? `cmm −${bdt(pnl.commission_total)}` : undefined}
            />
            <KpiCard
              label="Walk-in"
              value={bdt(walkInRev)}
              sub={totalRev > 0 ? `${pct(walkInRev / totalRev * 100)} of rev` : undefined}
            />
            <KpiCard
              label="Online"
              value={bdt(onlineRev)}
              sub={totalRev > 0 ? `${pct(onlineRev / totalRev * 100)} of rev` : undefined}
            />
          </div>

          {/* Row 2 — Profitability */}
          <div className="grid grid-cols-3 gap-2">
            <KpiCard
              label="Gross profit"
              value={bdt(pnl.gross_profit)}
              sub={grossMargin !== null ? `${pct(grossMargin)} margin` : undefined}
              accent="pos"
            />
            <KpiCard
              label={isProfit ? "Net profit" : "Net loss"}
              value={bdt(Math.abs(netProfit ?? 0))}
              accent={isProfit ? "pos" : "neg"}
            />
            <KpiCard
              label="COGS"
              value={bdt(pnl.cogs)}
              sub={cogsRatio !== null ? `${pct(cogsRatio)} of rev` : undefined}
              accent="neg"
            />
          </div>

          {/* Row 3 — Purchases + losses */}
          <div className="grid grid-cols-3 gap-2">
            {purchase !== null && (
              <KpiCard
                label="Purchases paid"
                value={bdt(purchase.total)}
                sub={`${purchase.record_count} invoice${purchase.record_count !== 1 ? "s" : ""}`}
              />
            )}
            <KpiCard label="Wastage" value={bdt(pnl.wastage_cost)} accent="neg" />
            <KpiCard label="Shrinkage" value={bdt(pnl.shrinkage_cost)} accent="neg" />
          </div>

          {/* Row 4 — Costs */}
          <div className="grid grid-cols-3 gap-2">
            <KpiCard label="Fixed costs" value={bdt(pnl.fixed_costs)} accent="neg" />
            <KpiCard
              label="Variable + adhoc"
              value={bdt(String(Number(pnl.variable_costs) + Number(pnl.adhoc_costs)))}
              accent="neg"
            />
            {stock && (
              <KpiCard
                label="Stock on hand"
                value={bdt(stock.total_value)}
                sub="current · not period"
              />
            )}
          </div>
        </section>
      )}

      {/* ══════════════════════════════════════════════
          PURCHASE vs COGS INSIGHT
      ══════════════════════════════════════════════ */}
      {purchaseCogsGap !== null && (
        <div className="rounded border border-dashed border-[#d8cdb0] bg-[#fffdf7] p-3.5">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
            Purchase efficiency
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <Metric label="Paid for ingredients" value={bdt(purchaseTotal)} />
            <Metric label="Recipe cost of sales (COGS)" value={bdt(cogsTotal)} />
            <Metric
              label="Gap (wastage + shrinkage risk)"
              value={purchaseCogsGap > 0 ? `+${bdt(purchaseCogsGap)}` : bdt(purchaseCogsGap)}
              color={purchaseCogsGap > 0 ? "text-chili-deep" : "text-leaf-deep"}
            />
          </div>
          <p className="mt-1.5 font-mono text-[10px] text-ink-soft">
            A large gap means you paid for more ingredient than what went into sold products — the difference is waste, shrinkage, or unsold prep.
          </p>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          FULL P&L LEDGER
      ══════════════════════════════════════════════ */}
      {pnl && (
        <section className="flex flex-col gap-2">
          <h2 className="sec">Profit & Loss</h2>
          <table className="ledger max-w-[520px]">
            <tbody>
              <tr><td>Revenue (actual sell value)</td><td>{bdt(pnl.gross_revenue)}</td></tr>
              {Number(pnl.commission_total) > 0 && (
                <tr><td>Commission (platform fees)</td><td className="neg">− {bdt(pnl.commission_total)}</td></tr>
              )}
              {Number(pnl.channel_discount) > 0 && (
                <tr><td>Platform promotions / discounts</td><td className="neg">− {bdt(pnl.channel_discount)}</td></tr>
              )}
              <tr><td>Cost of goods sold</td><td className="neg">− {bdt(pnl.cogs)}</td></tr>
              <tr><td>Packaging &amp; supplies</td><td className="neg">− {bdt(pnl.packaging_cost)}</td></tr>
              <tr className="section"><td colSpan={2}>Costs</td></tr>
              <tr><td>Fixed (rent, salary)</td><td className="neg">− {bdt(pnl.fixed_costs)}</td></tr>
              <tr><td>Variable (gas, oil)</td><td className="neg">− {bdt(pnl.variable_costs)}</td></tr>
              <tr><td>Adhoc (repairs, misc)</td><td className="neg">− {bdt(pnl.adhoc_costs)}</td></tr>
              <tr className="subtotal">
                <td>Gross profit{grossMargin !== null ? ` (${pct(grossMargin)})` : ""}</td>
                <td>{bdt(displayGrossProfit ?? 0)}</td>
              </tr>
              <tr className="section"><td colSpan={2}>Losses</td></tr>
              <tr><td>Wastage (prepared, not sold)</td><td className="neg">− {bdt(pnl.wastage_cost)}</td></tr>
              <tr
                className="cursor-pointer select-none hover:bg-black/[0.02]"
                onClick={() => setShowShrinkage((v) => !v)}
              >
                <td>
                  Shrinkage (day-start ingredient loss)
                  <span className="ml-2 font-mono text-[10px] text-ink-soft/60">
                    {shrinkage === null
                      ? "…"
                      : shrinkage.rows.length > 0
                        ? `${showShrinkage ? "▲" : "▼"} ${shrinkage.rows.length} event${shrinkage.rows.length !== 1 ? "s" : ""}`
                        : `${showShrinkage ? "▲" : "▼"} details`}
                  </span>
                </td>
                <td className="neg">− {bdt(pnl.shrinkage_cost)}</td>
              </tr>
              {showShrinkage && (
                <tr>
                  <td colSpan={2} className="!p-0">
                    {shrinkage === null ? (
                      <p className="px-3 py-2 font-mono text-[11px] text-ink-soft/60">Loading…</p>
                    ) : shrinkage.rows.length === 0 ? (
                      <p className="px-3 py-2 font-mono text-[11px] text-ink-soft/60 italic">No shrinkage events in this period.</p>
                    ) : (
                      <table className="w-full text-[11px] font-mono border-t border-dashed border-[#d8cdb0]">
                        <thead>
                          <tr className="bg-[#f5f0e8]">
                            <th className="px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-wide text-ink-soft/60">Date</th>
                            <th className="px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-wide text-ink-soft/60">Ingredient</th>
                            <th className="px-3 py-1.5 text-right font-mono text-[10px] uppercase tracking-wide text-ink-soft/60">Shortfall</th>
                            <th className="px-3 py-1.5 text-right font-mono text-[10px] uppercase tracking-wide text-ink-soft/60">Cost</th>
                            <th className="px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-wide text-ink-soft/60">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-dashed divide-[#e8dfc8]">
                          {shrinkage.rows.map((r, i) => (
                            <tr key={i} className="bg-paper">
                              <td className="px-3 py-1.5 text-ink-soft">{r.date}</td>
                              <td className="px-3 py-1.5 text-ink">{r.ingredient}</td>
                              <td className="px-3 py-1.5 text-right text-chili">
                                −{Number(r.shortfall_qty).toFixed(2)} {r.base_unit}
                              </td>
                              <td className="px-3 py-1.5 text-right text-chili">− {bdt(r.cost)}</td>
                              <td className="px-3 py-1.5 text-ink-soft capitalize">
                                {r.reason ? r.reason.toLowerCase().replace(/_/g, " ") : "—"}
                                {r.note && <span className="ml-1 text-ink-soft/50">· {r.note}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              )}
              {Number(pnl.other_income) > 0 && (
                <>
                  <tr className="section"><td colSpan={2}>Other income</td></tr>
                  <tr><td>Other income (oil, recyclables, etc.)</td><td className="pos">+ {bdt(pnl.other_income)}</td></tr>
                </>
              )}
              <tr className="net">
                <td>{isProfit ? "Net profit" : "Net loss"}</td>
                <td className={isProfit ? "pos" : "neg"}>{bdt(pnl.net_profit)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* ══════════════════════════════════════════════
          CHANNEL BREAKDOWN — Walk-in vs Online
      ══════════════════════════════════════════════ */}
      {channels.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="sec">Revenue by channel</h2>

          {/* Stacked bar: walk-in (chrome) vs online (gold) */}
          {totalRev > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex h-3.5 overflow-hidden rounded-full bg-paper-dim">
                <div
                  className="bg-chrome transition-all"
                  style={{ width: `${(walkInRev / totalRev * 100).toFixed(1)}%` }}
                  title={`Walk-in ${bdt(walkInRev)}`}
                />
                <div
                  className="bg-gold transition-all"
                  style={{ width: `${(onlineRev / totalRev * 100).toFixed(1)}%` }}
                  title={`Online ${bdt(onlineRev)}`}
                />
              </div>
              <div className="flex flex-wrap gap-4 font-mono text-[10px] text-ink-soft">
                <span>
                  <span className="mr-1 inline-block h-2 w-2 rounded-full bg-chrome" />
                  Walk-in {bdt(walkInRev)} · {pct(walkInRev / totalRev * 100)}
                </span>
                <span>
                  <span className="mr-1 inline-block h-2 w-2 rounded-full bg-gold" />
                  Online {bdt(onlineRev)} · {pct(onlineRev / totalRev * 100)}
                </span>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="datatable min-w-[520px]">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="text-right">Units</th>
                  <th className="text-right">Gross</th>
                  <th className="text-right">Commission</th>
                  <th className="text-right">Platform discount</th>
                  <th className="text-right">Net revenue</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.channel_id}>
                    <td className="font-medium">{c.channel_name}</td>
                    <td className="text-right font-mono">{num(c.units_sold)}</td>
                    <td className="text-right font-mono">{bdt(c.gross_revenue)}</td>
                    <td className="text-right font-mono text-chili">
                      {Number(c.commission) > 0 ? `− ${bdt(c.commission)}` : "—"}
                    </td>
                    <td className="text-right font-mono text-ink-soft">
                      {Number(c.platform_discount) > 0 ? bdt(c.platform_discount) : "—"}
                    </td>
                    <td className="text-right font-mono font-semibold">{bdt(c.net_revenue)}</td>
                    <td className="text-right font-mono text-ink-soft">
                      {totalRev > 0 ? pct(Number(c.gross_revenue) / totalRev * 100) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ══════════════════════════════════════════════
          PRODUCT PERFORMANCE
      ══════════════════════════════════════════════ */}
      {products.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="sec">
              Products by revenue
              <span className="ml-2 font-mono text-[10px] font-normal text-ink-soft">
                {prodExpanded ? `all ${productTotalCount}` : `top ${products.length}${productTotalCount > products.length ? ` of ${productTotalCount}` : ""}`}
              </span>
            </h2>
            <Link href="/owner/sales" className="font-mono text-[10px] text-chrome underline-offset-2 hover:underline">
              Full sales report →
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[640px]">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Cat.</th>
                  <th className="cursor-pointer select-none text-right" onClick={() => toggleSort("units_sold")}>Units{ind("units_sold")}</th>
                  <th className="cursor-pointer select-none text-right" onClick={() => toggleSort("gross_revenue")}>Revenue{ind("gross_revenue")}</th>
                  <th className="cursor-pointer select-none text-right" onClick={() => toggleSort("cogs")}>COGS{ind("cogs")}</th>
                  <th className="cursor-pointer select-none text-right" onClick={() => toggleSort("gross_profit")}>Gross profit{ind("gross_profit")}</th>
                  <th className="cursor-pointer select-none text-right" onClick={() => toggleSort("margin_pct")}>Margin{ind("margin_pct")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((p) => {
                  const margin = Number(p.margin_pct);
                  const mColor = margin >= 30
                    ? "text-leaf-deep"
                    : margin >= 15
                    ? "text-gold-deep"
                    : "text-chili";
                  return (
                    <tr key={p.product_id}>
                      <td className="font-medium">{p.product_name}</td>
                      <td className="font-mono text-[10px] text-ink-soft">{p.category}</td>
                      <td className="text-right font-mono">{num(p.units_sold)}</td>
                      <td className="text-right font-mono">{bdt(p.gross_revenue)}</td>
                      <td className="text-right font-mono text-ink-soft">{bdt(p.cogs)}</td>
                      <td className="text-right font-mono">{bdt(p.gross_profit)}</td>
                      <td className={`text-right font-mono font-semibold ${mColor}`}>
                        {pct(margin)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] text-ink-soft">
              Margin ≥30% <span className="text-leaf-deep">green</span> · 15–30% <span className="text-gold-deep">amber</span> · &lt;15% <span className="text-chili">red</span>
            </p>
            {productTotalCount > products.length && (
              prodExpanded ? (
                <button
                  className="font-mono text-[10px] text-ink-soft hover:text-ink"
                  onClick={() => setProdExpanded(false)}
                >
                  ▲ Show less
                </button>
              ) : (
                <button
                  className="font-mono text-[10px] text-chrome hover:underline disabled:opacity-50"
                  disabled={prodExpandLoading}
                  onClick={expandProducts}
                >
                  {prodExpandLoading ? "Loading…" : `▼ Show all ${productTotalCount} products`}
                </button>
              )
            )}
          </div>
        </section>
      )}

      {/* ══════════════════════════════════════════════
          DAILY REVENUE TREND
      ══════════════════════════════════════════════ */}
      {trend.length > 1 && (
        <section className="flex flex-col gap-2">
          <h2 className="sec">Daily revenue trend</h2>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[360px]">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="text-right">Units</th>
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
                      <td className="w-28 pl-2">
                        <div className="h-2 rounded-full bg-paper-dim">
                          <div className="h-2 rounded-full bg-chrome" style={{ width: `${barW}%` }} />
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

      {/* ══════════════════════════════════════════════
          PURCHASE INVOICES (collapsible)
      ══════════════════════════════════════════════ */}
      {purchase && purchase.records.length > 0 && (
        <section className="flex flex-col gap-2">
          <button
            className="flex items-center gap-2 text-left"
            onClick={() => setShowInvoices((v) => !v)}
          >
            <h2 className="sec">
              Purchase invoices
              <span className="ml-2 font-mono text-[11px] font-normal text-ink-soft">
                {purchase.record_count} record{purchase.record_count !== 1 ? "s" : ""} · {bdt(purchase.total)}
              </span>
            </h2>
            <span className="ml-auto font-mono text-[10px] text-ink-soft">
              {showInvoices ? "▲ hide" : "▼ show"}
            </span>
          </button>
          {showInvoices && (
            <div className="overflow-x-auto">
              <table className="datatable min-w-[360px]">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Invoice #</th>
                    <th className="text-right">Amount paid</th>
                  </tr>
                </thead>
                <tbody>
                  {purchase.records.map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono text-xs">{r.date}</td>
                      <td className="font-mono text-xs text-ink-soft">{r.invoice_number || "—"}</td>
                      <td className="text-right font-mono text-xs font-semibold">{bdt(r.amount)}</td>
                    </tr>
                  ))}
                  <tr className="subtotal">
                    <td colSpan={2}>Total paid</td>
                    <td className="text-right font-mono font-semibold">{bdt(purchase.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ══════════════════════════════════════════════
          RAW STOCK ON HAND (collapsible)
      ══════════════════════════════════════════════ */}
      {stock && (
        <section className="flex flex-col gap-2">
          <button
            className="flex items-center gap-2 text-left"
            onClick={() => setShowStockDetail((v) => !v)}
          >
            <h2 className="sec">Raw stock on hand</h2>
            <span className="font-mono text-xs font-semibold">{bdt(stock.total_value)}</span>
            <span className="ml-auto font-mono text-[10px] text-ink-soft">
              {showStockDetail ? "▲ hide" : "▼ show"}
            </span>
          </button>
          <p className="font-mono text-[10px] text-ink-soft">
            Current inventory valued at latest pack cost — capital tied up in storage (live, not filtered by date).
          </p>
          {showStockDetail && (
            <div className="overflow-x-auto">
              <table className="datatable min-w-[400px]">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th className="text-right">Qty on hand</th>
                    <th className="text-right">Cost / unit</th>
                    <th className="text-right">Value</th>
                    <th className="text-right">% of total</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.rows.map((r) => {
                    const share = Number(stock.total_value) > 0
                      ? Number(r.value) / Number(stock.total_value) * 100
                      : 0;
                    return (
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
                        <td className="text-right font-mono text-xs text-ink-soft">{pct(share)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "pos" | "neg";
}) {
  const valColor =
    accent === "pos" ? "text-leaf-deep" : accent === "neg" ? "text-chili" : "text-ink";
  return (
    <div className="rounded border border-[#d8cdb0] bg-paper px-2.5 py-2">
      <p className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">{label}</p>
      <p className={`font-mono text-[13px] font-bold leading-tight ${valColor}`}>{value}</p>
      {sub && <p className="font-mono text-[9px] text-ink-soft/70">{sub}</p>}
    </div>
  );
}

function Metric({
  label, value, color = "text-ink",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <span className="flex flex-col">
      <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">{label}</span>
      <span className={`font-mono text-xs font-semibold ${color}`}>{value}</span>
    </span>
  );
}
