"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { bdt, today } from "@/lib/format";
import type { Pnl } from "@/lib/types";

type Preset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "custom";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function rangeFor(preset: Preset, customStart: string, customEnd: string): { start: string; end: string } {
  const now = new Date();
  const end = today();

  if (preset === "today") return { start: end, end };

  if (preset === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const s = isoDate(y);
    return { start: s, end: s };
  }

  if (preset === "this_week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { start: isoDate(d), end };
  }

  if (preset === "last_week") {
    const d = new Date(now);
    // last Mon–Sun
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day - 6);
    const s = isoDate(d);
    d.setDate(d.getDate() + 6);
    return { start: s, end: isoDate(d) };
  }

  if (preset === "this_month") {
    return { start: end.slice(0, 8) + "01", end };
  }

  if (preset === "last_month") {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: isoDate(d), end: isoDate(last) };
  }

  return { start: customStart, end: customEnd };
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: "today",       label: "Today" },
  { value: "yesterday",   label: "Yesterday" },
  { value: "this_week",   label: "This week" },
  { value: "last_week",   label: "Last week" },
  { value: "this_month",  label: "This month" },
  { value: "last_month",  label: "Last month" },
  { value: "custom",      label: "Custom range" },
];

export default function PnlPage() {
  const [preset, setPreset] = useState<Preset>("this_month");
  const [customStart, setCustomStart] = useState(today().slice(0, 8) + "01");
  const [customEnd, setCustomEnd] = useState(today());
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [loading, setLoading] = useState(false);

  const { start, end } = rangeFor(preset, customStart, customEnd);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<Pnl>(`/reports/pnl/?outlet=1&start=${start}&end=${end}`);
      setPnl(data);
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    if (preset !== "custom") load();
  }, [preset, load]);

  const grossMarginPct = pnl && Number(pnl.revenue) > 0
    ? (Number(pnl.gross_profit) / Number(pnl.revenue) * 100).toFixed(1) + "%"
    : null;

  const netColor = pnl
    ? Number(pnl.net_profit) >= 0 ? "pos" : "neg"
    : "";

  const labelFor = PRESETS.find((p) => p.value === preset)?.label ?? preset;
  const rangeLabel = preset === "custom"
    ? `${customStart} → ${customEnd}`
    : `${labelFor} · ${start}${start !== end ? ` → ${end}` : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Profit &amp; loss</h1>
        <p className="font-mono text-[11px] text-ink-soft">{rangeLabel}</p>
      </div>

      {/* Preset chips */}
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
          <input
            type="date"
            className="field-input !py-1 !text-xs"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
          />
          <span className="font-mono text-xs text-ink-soft">→</span>
          <input
            type="date"
            className="field-input !py-1 !text-xs"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
          />
          <button
            className="btn btn-primary !py-1 !px-3 !text-xs"
            disabled={loading}
            onClick={load}
          >
            {loading ? "…" : "Apply"}
          </button>
        </div>
      )}

      {loading && <p className="font-mono text-xs text-ink-soft">Loading…</p>}

      {pnl && !loading && (
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
              <td>Gross profit{grossMarginPct ? ` (${grossMarginPct})` : ""}</td>
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
              <td>Packaging &amp; supplies</td>
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
            {Number(pnl.other_income) !== 0 && (
              <>
                <tr className="section">
                  <td colSpan={2}>Other income</td>
                </tr>
                <tr>
                  <td>Other income (oil, recyclables, etc.)</td>
                  <td className="pos">+ {bdt(pnl.other_income)}</td>
                </tr>
              </>
            )}
            <tr className="net">
              <td>Net profit</td>
              <td className={netColor}>{bdt(pnl.net_profit)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
