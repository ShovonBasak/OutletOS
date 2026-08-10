"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

interface StockInHistoryRow {
  id: number;
  name: string;
  base_unit: string;
  group: string;
  daily: Record<string, number>;
  total: number;
  stock: number | null;
}

interface StockInHistoryResponse {
  dates: string[];
  rows: StockInHistoryRow[];
}

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${parseInt(d)}/${m}`;
}

function fmtQty(qty: number) {
  return qty % 1 === 0 ? String(qty) : qty.toFixed(1);
}

export default function StockInHistoryPage() {
  const [start, setStart] = useState(monthStart());
  const [end, setEnd] = useState(today());
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("All");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<StockInHistoryResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<StockInHistoryResponse>(
        `/reports/stock-in-history/?outlet=1&start=${start}&end=${end}`
      );
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    if (!data) return ["All"];
    const gs = Array.from(new Set(data.rows.map((r) => r.group).filter(Boolean))).sort();
    return ["All", ...gs];
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      const matchGroup = groupFilter === "All" || r.group === groupFilter;
      const matchSearch = !search || r.name.toLowerCase().includes(search.toLowerCase());
      return matchGroup && matchSearch;
    });
  }, [data, groupFilter, search]);

  const dateTotals = useMemo(() => {
    if (!data) return {};
    const totals: Record<string, number> = {};
    for (const d of data.dates) {
      totals[d] = filtered.reduce((acc, r) => acc + (r.daily[d] ?? 0), 0);
    }
    return totals;
  }, [data, filtered]);

  const grandTotal = useMemo(() => filtered.reduce((acc, r) => acc + r.total, 0), [filtered]);

  const dates = data?.dates ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* Header + date range */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-ink">Stock in history</h1>
          <p className="text-xs text-ink-soft">Approved deliveries per ingredient, by date (base units)</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            className="field-input !py-1 !text-xs"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <span className="font-mono text-xs text-ink-soft">→</span>
          <input
            type="date"
            className="field-input !py-1 !text-xs"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
          <button
            className="btn btn-primary !py-1 !px-3 !text-xs"
            onClick={load}
            disabled={loading}
          >
            {loading ? "…" : "Go"}
          </button>
        </div>
      </div>

      {/* Search + group chips */}
      <div className="flex flex-col gap-2">
        <input
          type="text"
          className="field-input !py-1.5 text-sm max-w-xs"
          placeholder="Search ingredient…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setGroupFilter(g)}
              className={`rounded-full px-3 py-0.5 text-xs font-medium border transition-colors ${
                groupFilter === g
                  ? "bg-action text-paper border-action"
                  : "border-ink/20 text-ink-soft hover:border-ink/40"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {/* Summary chips */}
      {data && (
        <div className="flex flex-wrap gap-3 text-xs">
          <span className="rounded bg-paper border border-ink/10 px-3 py-1 text-ink-soft">
            Period <span className="font-mono text-ink">{start} → {end}</span>
          </span>
          <span className="rounded bg-paper border border-ink/10 px-3 py-1 text-ink-soft">
            Ingredients <span className="font-semibold text-ink">{filtered.length}</span>
          </span>
          <span className="rounded bg-paper border border-ink/10 px-3 py-1 text-ink-soft">
            Total received <span className="font-semibold text-ink">{fmtQty(grandTotal)}</span>
          </span>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-ink/10">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="bg-action text-paper">
              <th className="sticky left-0 z-10 bg-action px-4 py-2.5 text-left font-semibold text-xs uppercase tracking-wide min-w-[180px]">
                Ingredient
              </th>
              {dates.map((d) => (
                <th
                  key={d}
                  className="px-3 py-2.5 text-center font-semibold text-xs uppercase tracking-wide whitespace-nowrap"
                >
                  {fmtDate(d)}
                </th>
              ))}
              <th className="px-3 py-2.5 text-center font-semibold text-xs uppercase tracking-wide bg-action/90">
                Total
              </th>
              <th className="px-3 py-2.5 text-center font-semibold text-xs uppercase tracking-wide">
                In stock
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={dates.length + 3}
                  className="px-4 py-8 text-center text-ink-soft text-xs"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={dates.length + 3}
                  className="px-4 py-8 text-center text-ink-soft text-xs"
                >
                  No approved stock-ins for the selected period
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((row, i) => (
                <tr
                  key={row.id}
                  className={i % 2 === 0 ? "bg-paper" : "bg-ink/[0.025]"}
                >
                  <td
                    className={`sticky left-0 z-[1] px-4 py-2 font-medium text-ink text-xs min-w-[180px] max-w-[240px] ${
                      i % 2 === 0 ? "bg-paper" : "bg-[#f7f5f3]"
                    }`}
                  >
                    <div className="leading-tight">{row.name}</div>
                    <div className="text-[10px] text-ink-soft mt-0.5">
                      {row.group || "—"} · {row.base_unit}
                    </div>
                  </td>
                  {dates.map((d) => {
                    const qty = row.daily[d] ?? 0;
                    return (
                      <td
                        key={d}
                        className={`px-3 py-2 text-center font-mono text-xs ${
                          qty === 0 ? "text-ink/25" : "text-ink"
                        }`}
                      >
                        {qty === 0 ? "—" : fmtQty(qty)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center font-mono text-xs font-semibold text-ink bg-gold/10">
                    {fmtQty(row.total)}
                  </td>
                  <td
                    className={`px-3 py-2 text-center font-mono text-xs font-semibold ${
                      row.stock === null
                        ? "text-ink-soft"
                        : row.stock === 0
                        ? "text-chili"
                        : row.stock <= 10
                        ? "text-gold"
                        : "text-leaf-deep"
                    }`}
                  >
                    {row.stock === null ? "—" : fmtQty(row.stock)}
                  </td>
                </tr>
              ))}
          </tbody>
          {!loading && filtered.length > 0 && (
            <tfoot>
              <tr className="bg-action/80 text-paper">
                <td className="sticky left-0 z-[1] bg-action/80 px-4 py-2 text-xs font-bold uppercase tracking-wide">
                  Total
                </td>
                {dates.map((d) => (
                  <td
                    key={d}
                    className="px-3 py-2 text-center font-mono text-xs font-bold"
                  >
                    {dateTotals[d] ? fmtQty(dateTotals[d]) : "—"}
                  </td>
                ))}
                <td className="px-3 py-2 text-center font-mono text-xs font-bold">
                  {fmtQty(grandTotal)}
                </td>
                <td className="px-3 py-2 text-center text-xs">—</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
