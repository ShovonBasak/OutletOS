"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { bdt } from "@/lib/format";
import type { DashboardData, Pnl } from "@/lib/types";

// ── Period helpers ────────────────────────────────────────────────────────────

type Period = "7d" | "30d" | "month" | "last_month" | "custom";

const PERIODS: { value: Period; label: string }[] = [
  { value: "7d",         label: "7 days" },
  { value: "30d",        label: "30 days" },
  { value: "month",      label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom",     label: "Custom" },
];

function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function periodRange(p: Period): { start: string; end: string } {
  const now = new Date();
  const end = localDate(now);
  if (p === "7d") {
    const s = new Date(now); s.setDate(s.getDate() - 6);
    return { start: localDate(s), end };
  }
  if (p === "30d") {
    const s = new Date(now); s.setDate(s.getDate() - 29);
    return { start: localDate(s), end };
  }
  if (p === "month") {
    return { start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`, end };
  }
  // last_month
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last  = new Date(now.getFullYear(), now.getMonth(), 0);
  return { start: localDate(first), end: localDate(last) };
}

// ── Number helpers ────────────────────────────────────────────────────────────

function niceMax(n: number): number {
  if (n <= 0) return 1000;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / mag;
  const nice = norm <= 1.5 ? 1.5 : norm <= 2 ? 2 : norm <= 3 ? 3 : norm <= 4 ? 4 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function shortK(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 100_000) return `${(n / 1000).toFixed(0)}k`;
  if (Math.abs(n) >= 1_000)   return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function pct(a: number, b: number) {
  if (!b) return "—";
  return `${((a / b) * 100).toFixed(1)}%`;
}

// ── SVG: Daily bar chart ──────────────────────────────────────────────────────

function DailyBarChart({ daily }: { daily: DashboardData["daily"] }) {
  if (daily.length === 0) {
    return <p className="py-6 text-center font-mono text-xs text-ink-soft italic">No closed days in this period.</p>;
  }

  const W = 600, H = 195;
  const PAD = { t: 14, r: 12, b: 36, l: 48 };
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;

  const maxRev = Math.max(...daily.map(d => Number(d.revenue)));
  const top = niceMax(maxRev);
  const scale = ph / top;

  const groupW = pw / daily.length;
  const barW = Math.max(2, groupW * 0.72);
  const barOff = (groupW - barW) / 2;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: PAD.t + ph * (1 - t),
    label: shortK(top * t),
  }));

  const step = daily.length <= 10 ? 1 : Math.ceil(daily.length / 9);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* grid lines + y labels */}
      {ticks.map((tk, i) => (
        <g key={i}>
          <line x1={PAD.l} y1={tk.y} x2={W - PAD.r} y2={tk.y}
                stroke="#e8dfc8" strokeWidth={i === 0 ? "0.8" : "0.4"} />
          <text x={PAD.l - 5} y={tk.y + 3} textAnchor="end"
                fontFamily="monospace" fontSize="7.5" fill="#9B8A78">
            {tk.label}
          </text>
        </g>
      ))}

      {/* bars */}
      {daily.map((d, i) => {
        const x   = PAD.l + i * groupW + barOff;
        const rev = Number(d.revenue);
        const cogs = Math.min(Number(d.cogs), rev);
        const gp  = rev - cogs;
        const revH  = rev  * scale;
        const cogsH = cogs * scale;
        const gpH   = gp   * scale;
        const baseY = PAD.t + ph;

        return (
          <g key={i}>
            <title>{`${d.date}  Rev: ${bdt(rev)}  COGS: ${bdt(cogs)}  GP: ${bdt(gp)}`}</title>
            {gpH   > 0 && <rect x={x} y={baseY - revH}        width={barW} height={gpH}   fill="#7A2420" opacity="0.82" rx="1.5" />}
            {cogsH > 0 && <rect x={x} y={baseY - cogsH}       width={barW} height={cogsH} fill="#C9A227" opacity="0.75" rx="1.5" />}
          </g>
        );
      })}

      {/* x-axis date labels */}
      {daily.map((d, i) => {
        if (i % step !== 0 && i !== daily.length - 1) return null;
        const cx = PAD.l + i * groupW + groupW / 2;
        const label = d.date.slice(5).replace("-", "/");
        return (
          <text key={i} x={cx} y={H - 6} textAnchor="middle"
                fontFamily="monospace" fontSize="7.5" fill="#9B8A78">
            {label}
          </text>
        );
      })}
    </svg>
  );
}

// ── SVG: Top products horizontal bars ────────────────────────────────────────

function TopProductsChart({ products }: { products: DashboardData["top_products"] }) {
  if (products.length === 0) {
    return <p className="py-4 text-center font-mono text-xs text-ink-soft italic">No sales data.</p>;
  }
  const maxRev = Math.max(...products.map(p => Number(p.revenue)));

  return (
    <div className="flex flex-col gap-2.5">
      {products.map((p, i) => {
        const rev  = Number(p.revenue);
        const cogs = Number(p.cogs);
        const gp   = rev - cogs;
        const margin = Number(p.margin_pct);
        const revPct  = maxRev > 0 ? (rev  / maxRev) * 100 : 0;
        const cogsPct = maxRev > 0 ? (cogs / maxRev) * 100 : 0;
        const marginColor = margin >= 40 ? "text-leaf-deep" : margin >= 20 ? "text-gold-deep" : "text-chili";

        return (
          <div key={i}>
            <div className="grid grid-cols-[1fr_5.5rem_5.5rem_3.5rem] gap-x-2 items-baseline mb-0.5">
              <span className="font-mono text-[10px] text-ink">{p.product_name}</span>
              <span className="font-mono text-[10px] text-ink text-right">{bdt(rev)}</span>
              <span className="font-mono text-[10px] text-ink-soft text-right">{bdt(cogs)}</span>
              <span className={`font-mono text-[10px] font-semibold text-right ${marginColor}`}>{margin.toFixed(0)}%</span>
            </div>
            <div className="h-[7px] bg-paper-dim rounded overflow-hidden">
              <div className="h-full flex rounded overflow-hidden">
                <div style={{ width: `${revPct - cogsPct}%`, backgroundColor: "#7A2420", opacity: 0.75 }} />
                <div style={{ width: `${cogsPct}%`, backgroundColor: "#C9A227", opacity: 0.65 }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── P&L waterfall ─────────────────────────────────────────────────────────────

function PnlWaterfall({ pnl }: { pnl: Pnl }) {
  const revenue = Number(pnl.revenue);

  const rows = [
    { label: "Revenue",     value: revenue,                  sign: "+" as const },
    { label: "COGS",        value: Number(pnl.cogs),         sign: "−" as const },
    { label: "Wastage",     value: Number(pnl.wastage_cost), sign: "−" as const },
    { label: "Shrinkage",   value: Number(pnl.shrinkage_cost), sign: "−" as const },
    { label: "Packaging",   value: Number(pnl.packaging_cost), sign: "−" as const },
    { label: "Fixed costs", value: Number(pnl.fixed_costs),  sign: "−" as const },
    { label: "Variable",    value: Number(pnl.variable_costs), sign: "−" as const },
    { label: "Adhoc",       value: Number(pnl.adhoc_costs),  sign: "−" as const },
    { label: "Other income",value: Number(pnl.other_income), sign: "+" as const },
  ].filter(r => r.value > 0);

  const net = Number(pnl.net_profit);
  const ref = revenue || 1;

  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => {
        const w = Math.min((r.value / ref) * 100, 100);
        const isPos = r.sign === "+";
        const barColor = r.label === "Revenue" ? "#3F6B3F" : isPos ? "#3F6B3F" : "#9B2E2B";
        return (
          <div key={i} className="grid grid-cols-[6.5rem_1fr_6rem] items-center gap-2">
            <span className="font-mono text-[10px] text-ink-soft text-right">{r.label}</span>
            <div className="h-[18px] bg-paper-dim rounded overflow-hidden">
              <div className="h-full rounded" style={{ width: `${w}%`, backgroundColor: barColor, opacity: r.label === "Revenue" ? 0.7 : 0.55 }} />
            </div>
            <span className={`font-mono text-[11px] font-semibold text-right ${isPos ? "text-leaf-deep" : "text-chili"}`}>
              {r.sign} {bdt(r.value)}
            </span>
          </div>
        );
      })}
      <div className="grid grid-cols-[6.5rem_1fr_6rem] items-center gap-2 mt-1 border-t border-dashed border-[#d8cdb0] pt-2">
        <span className="font-mono text-[10px] font-bold text-ink text-right">Net profit</span>
        <div className="h-[18px] bg-paper-dim rounded overflow-hidden">
          <div className="h-full rounded"
               style={{ width: `${Math.min(Math.abs(net) / ref * 100, 100)}%`, backgroundColor: net >= 0 ? "#3F6B3F" : "#C9601C" }} />
        </div>
        <span className={`font-mono text-[13px] font-bold text-right ${net >= 0 ? "text-leaf-deep" : "text-chili"}`}>
          {bdt(net)}
        </span>
      </div>
    </div>
  );
}

// ── Channel split ─────────────────────────────────────────────────────────────

function ChannelBars({ channels, total }: { channels: DashboardData["channels"]; total: number }) {
  if (channels.length === 0) {
    return <p className="py-4 text-center font-mono text-xs text-ink-soft italic">No channel data.</p>;
  }
  const COLORS = ["#7A2420", "#C9A227", "#3F6B3F", "#C9601C", "#5C6B8A"];

  const ROW = "grid grid-cols-[1fr_6rem_4rem] sm:grid-cols-[1fr_4.5rem_6rem_4.5rem_5rem] gap-x-3";

  return (
    <div className="flex flex-col gap-3">
      <div className={`${ROW} pb-1`}>
        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Channel</span>
        <span className="hidden sm:block font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Units</span>
        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Revenue</span>
        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Share</span>
        <span className="hidden sm:block font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Commission</span>
      </div>
      {channels.map((ch, i) => {
        const rev  = Number(ch.revenue);
        const share = total > 0 ? (rev / total) * 100 : 0;
        const color = COLORS[i % COLORS.length];
        return (
          <div key={i}>
            <div className={`${ROW} items-center mb-1`}>
              <span className="font-mono text-[11px] text-ink font-medium">{ch.channel}</span>
              <span className="hidden sm:block font-mono text-[10px] text-ink-soft text-right">{ch.units_sold}</span>
              <span className="font-mono text-[11px] text-ink font-semibold text-right">{bdt(rev)}</span>
              <span className="font-mono text-[10px] text-ink-soft text-right">{share.toFixed(0)}%</span>
              <span className="hidden sm:block font-mono text-[10px] text-ink-soft text-right">{Number(ch.commission) > 0 ? `− ${bdt(ch.commission)}` : "—"}</span>
            </div>
            <div className="h-2 bg-paper-dim rounded overflow-hidden">
              <div className="h-full rounded" style={{ width: `${share}%`, backgroundColor: color, opacity: 0.7 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#d8cdb0] bg-paper overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[#d8cdb0]">
        <h2 className="font-mono text-[10px] font-semibold uppercase tracking-widest text-chrome">{title}</h2>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color = "text-ink" }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col rounded-xl border border-[#d8cdb0] bg-paper px-4 py-3">
      <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft mb-1">{label}</span>
      <span className={`font-display text-[20px] font-bold leading-tight ${color}`}>{value}</span>
      {sub && <span className="font-mono text-[9px] text-ink-soft mt-0.5">{sub}</span>}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="flex items-center gap-4 mt-2">
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-5 rounded-sm" style={{ backgroundColor: "#7A2420", opacity: 0.82 }} />
        <span className="font-mono text-[9px] text-ink-soft">Gross profit</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-5 rounded-sm" style={{ backgroundColor: "#C9A227", opacity: 0.75 }} />
        <span className="font-mono text-[9px] text-ink-soft">COGS</span>
      </div>
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function OwnerDashboard() {
  const [period, setPeriod] = useState<Period>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd]     = useState("");
  const [range, setRange]   = useState<{ start: string; end: string }>(periodRange("30d"));
  const [data, setData]     = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setData(null);
    try {
      const d = await api<DashboardData>(`/reports/dashboard/?outlet=1&start=${range.start}&end=${range.end}`);
      setData(d);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  function selectPeriod(p: Period) {
    setPeriod(p);
    if (p !== "custom") setRange(periodRange(p));
  }

  function applyCustom() {
    if (customStart && customEnd && customStart <= customEnd) {
      setRange({ start: customStart, end: customEnd });
    }
  }

  const revenue    = data ? Number(data.pnl.revenue)    : 0;
  const netProfit  = data ? Number(data.pnl.net_profit) : 0;
  const cogs       = data ? Number(data.pnl.cogs)       : 0;
  const grossProfit = revenue - cogs;
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const totalUnits = data?.daily.reduce((s, d) => s + d.units_sold, 0) ?? 0;
  const activeDays = data?.daily.length ?? 0;
  const totalRevenue = data?.channels.reduce((s, c) => s + Number(c.revenue), 0) ?? 0;

  return (
    <div className="flex flex-col gap-5">

      {/* ── Period picker ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-1.5 flex-wrap">
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => selectPeriod(p.value)}
              className={`rounded-full px-3.5 py-1.5 font-mono text-[10px] font-medium transition-colors ${
                period === p.value
                  ? "bg-near-black text-gold"
                  : "border border-[#d8cdb0] text-ink-soft hover:border-ink-soft"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {period === "custom" && (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={e => setCustomStart(e.target.value)}
              className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-2 py-1 font-mono text-[11px] text-ink"
            />
            <span className="font-mono text-[10px] text-ink-soft">to</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={e => setCustomEnd(e.target.value)}
              className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-2 py-1 font-mono text-[11px] text-ink"
            />
            <button
              onClick={applyCustom}
              disabled={!customStart || !customEnd || customStart > customEnd}
              className="rounded-full bg-near-black px-3.5 py-1.5 font-mono text-[10px] font-medium text-gold disabled:opacity-40"
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {loading && (
        <p className="py-10 text-center font-mono text-xs text-ink-soft">Loading…</p>
      )}

      {data && (
        <>
          {/* ── KPI strip ────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <KpiCard
              label="Revenue"
              value={bdt(revenue)}
              sub={`${activeDays} day${activeDays !== 1 ? "s" : ""}`}
              color={revenue > 0 ? "text-leaf-deep" : "text-ink"}
            />
            <KpiCard
              label="Net profit"
              value={bdt(netProfit)}
              sub={pct(netProfit, revenue) !== "—" ? `${pct(netProfit, revenue)} margin` : undefined}
              color={netProfit > 0 ? "text-leaf-deep" : netProfit < 0 ? "text-chili" : "text-ink"}
            />
            <KpiCard
              label="Gross margin"
              value={`${grossMargin.toFixed(1)}%`}
              sub={`GP ${bdt(grossProfit)}`}
              color={grossMargin >= 40 ? "text-leaf-deep" : grossMargin >= 20 ? "text-gold-deep" : "text-chili"}
            />
            <KpiCard
              label="COGS"
              value={bdt(cogs)}
              sub={pct(cogs, revenue) !== "—" ? `${pct(cogs, revenue)} of rev` : undefined}
              color="text-ink-soft"
            />
            <KpiCard
              label="Units sold"
              value={totalUnits.toLocaleString()}
              sub={activeDays > 0 ? `avg ${(totalUnits / activeDays).toFixed(0)}/day` : undefined}
            />
          </div>

          {/* ── Daily bar chart ───────────────────────────────────────── */}
          <Card
            title={`Daily revenue vs COGS — ${data.start} to ${data.end}`}
            action={
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 font-mono text-[9px] text-ink-soft">
                  <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: "#7A2420", opacity: 0.82 }} />
                  Gross profit
                </span>
                <span className="flex items-center gap-1 font-mono text-[9px] text-ink-soft">
                  <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: "#C9A227", opacity: 0.75 }} />
                  COGS
                </span>
              </div>
            }
          >
            <div className="overflow-x-auto">
              <div className="min-w-[380px]">
                <DailyBarChart daily={data.daily} />
              </div>
            </div>
          </Card>

          {/* ── Two-column: Products + P&L ────────────────────────────── */}
          <div className="grid gap-5 md:grid-cols-2">
            <Card title="Top products by revenue">
              <div className="grid grid-cols-[1fr_5.5rem_5.5rem_3.5rem] gap-x-2 pb-2 border-b border-dashed border-[#e8dfc8]">
                <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Product</span>
                <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Revenue</span>
                <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">COGS</span>
                <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Margin</span>
              </div>
              <div className="mt-3">
                <TopProductsChart products={data.top_products} />
              </div>
            </Card>

            <Card title="P&L breakdown">
              <PnlWaterfall pnl={data.pnl} />
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-dashed border-[#d8cdb0] pt-4">
                {[
                  { label: "Wastage", value: bdt(data.pnl.wastage_cost), color: "text-chili" },
                  { label: "Shrinkage", value: bdt(data.pnl.shrinkage_cost), color: "text-chili" },
                  { label: "Other income", value: bdt(data.pnl.other_income), color: "text-leaf-deep" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex flex-col">
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">{label}</span>
                    <span className={`font-mono text-[12px] font-semibold ${color}`}>{value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* ── Channel breakdown ──────────────────────────────────────── */}
          <Card title="Revenue by sales channel">
            <ChannelBars channels={data.channels} total={totalRevenue} />
          </Card>
        </>
      )}
    </div>
  );
}
