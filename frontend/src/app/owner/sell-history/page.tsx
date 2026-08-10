"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

interface SellHistoryRow {
  id: number;
  name: string;
  category: string;
  daily: Record<string, number>;
  total: number;
  stock: number | null;
}

interface SellHistoryResponse {
  dates: string[];
  rows: SellHistoryRow[];
}

function sevenDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${parseInt(d)}/${m}`;
}

export default function SellHistoryPage() {
  const [start, setStart] = useState(sevenDaysAgo());
  const [end, setEnd] = useState(today());
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SellHistoryResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<SellHistoryResponse>(
        `/reports/sell-history/?outlet=1&start=${start}&end=${end}`
      );
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(() => {
    if (!data) return ["All"];
    const cats = Array.from(new Set(data.rows.map((r) => r.category).filter(Boolean))).sort();
    return ["All", ...cats];
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      const matchCat = catFilter === "All" || r.category === catFilter;
      const matchSearch = !search || r.name.toLowerCase().includes(search.toLowerCase());
      return matchCat && matchSearch;
    });
  }, [data, catFilter, search]);

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
          <h1 className="font-display text-xl font-bold text-ink">Sell history</h1>
          <p className="text-xs text-ink-soft">Units sold per product, by date</p>
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

      {/* Search + category chips */}
      <div className="flex flex-col gap-2">
        <input
          type="text"
          className="field-input !py-1.5 text-sm max-w-xs"
          placeholder="Search product…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCatFilter(cat)}
              className={`rounded-full px-3 py-0.5 text-xs font-medium border transition-colors ${
                catFilter === cat
                  ? "bg-action text-paper border-action"
                  : "border-ink/20 text-ink-soft hover:border-ink/40"
              }`}
            >
              {cat}
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
            Products <span className="font-semibold text-ink">{filtered.length}</span>
          </span>
          <span className="rounded bg-paper border border-ink/10 px-3 py-1 text-ink-soft">
            Total sold <span className="font-semibold text-ink">{grandTotal}</span>
          </span>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-ink/10">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="bg-action text-paper">
              <th
                className="sticky left-0 z-10 bg-action px-4 py-2.5 text-left font-semibold text-xs uppercase tracking-wide min-w-[180px]"
              >
                Product
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
                Stock
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
                  No data for the selected period
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((row, i) => (
                <tr
                  key={row.id}
                  className={i % 2 === 0 ? "bg-paper" : "bg-ink/[0.025]"}
                >
                  <td className={`sticky left-0 z-[1] px-4 py-2 font-medium text-ink text-xs min-w-[180px] max-w-[240px] ${
                    i % 2 === 0 ? "bg-paper" : "bg-[#f7f5f3]"
                  }`}>
                    <div className="leading-tight">{row.name}</div>
                    {row.category && (
                      <div className="text-[10px] text-ink-soft mt-0.5">{row.category}</div>
                    )}
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
                        {qty === 0 ? "—" : qty}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center font-mono text-xs font-semibold text-ink bg-gold/10">
                    {row.total}
                  </td>
                  <td
                    className={`px-3 py-2 text-center font-mono text-xs font-semibold ${
                      row.stock === null
                        ? "text-ink-soft"
                        : row.stock === 0
                        ? "text-chili"
                        : row.stock <= 5
                        ? "text-gold"
                        : "text-leaf-deep"
                    }`}
                  >
                    {row.stock === null ? "—" : row.stock}
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
                    {dateTotals[d] || "—"}
                  </td>
                ))}
                <td className="px-3 py-2 text-center font-mono text-xs font-bold">
                  {grandTotal}
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
