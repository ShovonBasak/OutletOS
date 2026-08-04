"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { packBreakdown } from "@/lib/format";
import type { DisplayStock, IngredientGroup, Paginated, RawStock } from "@/lib/types";

function bdt(val: string | null | undefined): string {
  if (!val) return "—";
  const n = parseFloat(val);
  return isNaN(n) ? "—" : `৳${n.toLocaleString("en-BD", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

const RAW_GROUPS: { key: IngredientGroup; label: string }[] = [
  { key: "CHICKEN_PIECE", label: "Chicken — Main" },
  { key: "SNACK",         label: "Snacks & Balls" },
  { key: "BURGER_WRAP",   label: "Burgers & Wraps" },
  { key: "BEVERAGE",      label: "Beverages" },
  { key: "SUPPLY",        label: "Supplies" },
  { key: "OTHER",         label: "Other" },
];

const DISPLAY_GROUPS: { key: string; label: string }[] = [
  { key: "Chicken", label: "Chicken" },
  { key: "Fry",     label: "Fry" },
  { key: "Snack",   label: "Snacks" },
  { key: "Burger",  label: "Burgers" },
  { key: "Wrap",    label: "Wraps" },
  { key: "Sandwich",label: "Sandwiches" },
  { key: "Rice",    label: "Rice" },
  { key: "Beverage",label: "Beverages" },
  { key: "Add On",  label: "Add-Ons" },
  { key: "Combo",   label: "Combos" },
];

export default function StockLevels() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;

  const [raw, setRaw] = useState<RawStock[]>([]);
  const [ready, setReady] = useState<DisplayStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    const [r, d] = await Promise.all([
      api<Paginated<RawStock>>(`/raw-stock/?outlet=${outlet}`),
      api<Paginated<DisplayStock>>(`/display-stock/?outlet=${outlet}`),
    ]);
    setRaw(r.results);
    setReady(d.results);
    setLoading(false);
  }

  useEffect(() => { load(); }, [outlet]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = search.toLowerCase();

  const filteredRaw = useMemo(
    () => (q ? raw.filter((r) => r.ingredient_name.toLowerCase().includes(q)) : raw),
    [raw, q]
  );
  const filteredReady = useMemo(
    () => (q ? ready.filter((d) => d.product_name.toLowerCase().includes(q)) : ready),
    [ready, q]
  );

  const totalValue = useMemo(() => {
    let sum = 0;
    for (const r of raw) {
      if (r.cost_per_base_unit) sum += parseFloat(r.quantity_available) * parseFloat(r.cost_per_base_unit);
    }
    return sum;
  }, [raw]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold">Stock levels</h1>
          <p className="text-xs text-ink-soft">Raw ingredients &amp; ready-to-sell products</p>
        </div>
        <button className="shrink-0 font-mono text-[10px] text-leaf-deep underline" onClick={load} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      <input
        type="search"
        className="field-input"
        placeholder="Search by name…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {totalValue > 0 && (
        <div className="ticket flex items-center justify-between py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Raw stock value (est.)</p>
          <p className="font-mono text-[15px] font-bold text-ink">{bdt(String(totalValue.toFixed(2)))}</p>
        </div>
      )}

      {/* ── Raw ingredients, grouped ── */}
      <section className="flex flex-col gap-4">
        <p className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Raw ingredients</p>
        {RAW_GROUPS.map(({ key, label }) => {
          const items = filteredRaw.filter((r) => r.ingredient_group === key);
          if (items.length === 0) return null;
          return (
            <div key={key}>
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft/60 border-b border-dotted border-[#d8cdb0] pb-0.5">
                {label}
              </p>
              <div className="flex flex-col gap-1.5">
                {items.map((r) => {
                  const packs = packBreakdown(r.quantity_available, r.pieces_per_pack, r.base_unit);
                  const value = r.cost_per_base_unit
                    ? parseFloat(r.quantity_available) * parseFloat(r.cost_per_base_unit)
                    : null;
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-3 rounded border border-[#d8cdb0] bg-paper px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-[12px] font-medium text-ink truncate">{r.ingredient_display_name}</p>
                        <p className="font-mono text-[10px] text-ink-soft">
                          {Number(r.quantity_available)} {r.base_unit}
                          {packs && <span className="ml-2 text-ink-soft/60">= {packs}</span>}
                        </p>
                      </div>
                      {value !== null && value > 0 && (
                        <p className="shrink-0 font-mono text-[11px] text-ink-soft">≈ {bdt(String(value.toFixed(0)))}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {filteredRaw.length === 0 && (
          <p className="font-mono text-xs text-ink-soft">{q ? "No ingredients match." : "No raw stock on hand."}</p>
        )}
      </section>

      {/* ── Display stock (ready to sell), grouped ── */}
      <section className="flex flex-col gap-4">
        <p className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Ready to sell</p>
        {DISPLAY_GROUPS.map(({ key, label }) => {
          const items = filteredReady.filter((d) => d.product_category === key);
          if (items.length === 0) return null;
          return (
            <div key={key}>
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft/60 border-b border-dotted border-[#d8cdb0] pb-0.5">
                {label}
              </p>
              <div className="flex flex-col gap-1.5">
                {items.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between gap-3 rounded border border-[#d8cdb0] bg-paper px-3 py-2"
                  >
                    <p className="font-mono text-[12px] font-medium text-ink truncate">{d.product_name}</p>
                    <p className="shrink-0 font-mono text-[12px] font-semibold text-ink">
                      {d.pieces_available} <span className="font-normal text-ink-soft">pcs</span>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {filteredReady.length === 0 && (
          <p className="font-mono text-xs text-ink-soft">{q ? "No products match." : "Nothing prepared yet."}</p>
        )}
      </section>
    </div>
  );
}
