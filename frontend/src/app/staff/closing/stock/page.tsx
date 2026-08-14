"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { bdt, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type { DailyClosing, Paginated, RawStock, StockCount } from "@/lib/types";

const CATEGORY_ORDER = [
  "Fried Chicken", "Snacks", "Light Snacks", "Meals",
  "Rice & Sides", "Beverages", "Add-on", "Combo",
];
function categoryRank(cat: string) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}
function sortedCounts(counts: StockCount[]) {
  return [...counts].sort(
    (a, b) =>
      categoryRank(a.product_category) - categoryRank(b.product_category) ||
      Number(a.unit_price) - Number(b.unit_price) ||
      a.product_name.localeCompare(b.product_name)
  );
}
function buildCatPrices(counts: StockCount[]) {
  const m = new Map<string, Set<number>>();
  for (const sc of counts) {
    if (!m.has(sc.product_category)) m.set(sc.product_category, new Set());
    m.get(sc.product_category)!.add(Number(sc.unit_price));
  }
  return m;
}

export default function StockSummaryScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();

  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [rawStock, setRawStock] = useState<RawStock[]>([]);

  useEffect(() => {
    Promise.all([
      getOrCreateTodayClosing(outlet, opDate),
      api<Paginated<RawStock>>(`/raw-stock/?outlet=${outlet}`),
    ]).then(([c, rs]) => {
      setClosing(c);
      setRawStock(rs.results.filter((r) => Number(r.quantity_available) > 0));
    });
  }, [outlet, opDate]);

  if (!closing) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  // Split stock counts into prepared vs ready (beverages/direct)
  const preparedCounts = closing.stock_counts
    .filter((sc) => sc.requires_preparation)
    .sort((a, b) => a.product_name.localeCompare(b.product_name));

  const readyCounts = closing.stock_counts
    .filter((sc) => !sc.requires_preparation)
    .sort((a, b) => a.product_name.localeCompare(b.product_name));

  // Raw ingredients that are RECIPE_LINKED — exclude BEVERAGE group since those
  // are already shown as products in the "Beverages & ready stock" section above.
  const recipeIngredients = rawStock.filter(
    (r) => r.tracking_mode === "RECIPE_LINKED" && r.ingredient_group !== "BEVERAGE"
  );
  const periodicIngredients = rawStock.filter((r) => r.tracking_mode === "PERIODIC_COUNT");

  const rawValue = (r: RawStock) =>
    Number(r.quantity_available) > 0 && r.cost_per_base_unit
      ? Number(r.quantity_available) * Number(r.cost_per_base_unit)
      : 0;

  const totalRemainsValue =
    closing.stock_counts.reduce((s, sc) => s + (Number(sc.remains_value) || 0), 0) +
    rawStock.reduce((s, r) => s + rawValue(r), 0);
  const totalRemainsPcs = closing.stock_counts.reduce((s, sc) => s + sc.remains_pieces, 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Stock summary</h1>
        <p className="text-xs text-ink-soft">End-of-day stock levels — physical counts</p>
      </div>

      {/* Total carry-out value */}
      <div className="ticket flex flex-row items-center justify-between !py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">
            Total remaining stock value
          </p>
          <p className="font-mono text-[10px] text-ink-soft/60 mt-0.5">
            {totalRemainsPcs} pcs across all products
          </p>
        </div>
        <span className="font-mono text-lg font-bold text-gold-deep">
          {bdt(totalRemainsValue)}
        </span>
      </div>

      {/* Prepared items — grouped by category then price */}
      {preparedCounts.length > 0 && (() => {
        const sorted = sortedCounts(preparedCounts);
        const catPrices = buildCatPrices(sorted);
        return (
          <Section title="Prepared items" subtitle="Physically counted at close">
            {sorted.map((sc, i) => {
              const prev = sorted[i - 1];
              const isFirstInCat = i === 0 || prev.product_category !== sc.product_category;
              const multiPrice = (catPrices.get(sc.product_category)?.size ?? 1) > 1;
              const isFirstInPrice = isFirstInCat || Number(prev.unit_price) !== Number(sc.unit_price);
              return (
                <React.Fragment key={sc.id}>
                  {isFirstInCat && sc.product_category && (
                    <div className={`px-3 pt-2 pb-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-soft/50`}>
                      {sc.product_category}
                    </div>
                  )}
                  {multiPrice && isFirstInPrice && (
                    <div className="pl-4 pr-3 pt-1 pb-0.5 font-mono text-[9px] text-ink-soft/35">
                      ৳{Number(sc.unit_price)} each
                    </div>
                  )}
                  <StockRow
                    name={sc.product_name}
                    qty={sc.remains_pieces}
                    unit="pcs"
                    value={sc.remains_pieces > 0 ? Number(sc.remains_value) : undefined}
                    dim={sc.remains_pieces === 0}
                    piecesPerPack={sc.pieces_per_pack ? Number(sc.pieces_per_pack) : null}
                  />
                </React.Fragment>
              );
            })}
          </Section>
        );
      })()}

      {/* Beverages & ready stock — grouped by category then price */}
      {readyCounts.length > 0 && (() => {
        const sorted = sortedCounts(readyCounts);
        const catPrices = buildCatPrices(sorted);
        return (
          <Section title="Beverages & ready stock" subtitle="Physically counted at close">
            {sorted.map((sc, i) => {
              const prev = sorted[i - 1];
              const isFirstInCat = i === 0 || prev.product_category !== sc.product_category;
              const multiPrice = (catPrices.get(sc.product_category)?.size ?? 1) > 1;
              const isFirstInPrice = isFirstInCat || Number(prev.unit_price) !== Number(sc.unit_price);
              return (
                <React.Fragment key={sc.id}>
                  {isFirstInCat && sc.product_category && (
                    <div className="px-3 pt-2 pb-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-soft/50">
                      {sc.product_category}
                    </div>
                  )}
                  {multiPrice && isFirstInPrice && (
                    <div className="pl-4 pr-3 pt-1 pb-0.5 font-mono text-[9px] text-ink-soft/35">
                      ৳{Number(sc.unit_price)} each
                    </div>
                  )}
                  <StockRow
                    name={sc.product_name}
                    qty={sc.remains_pieces}
                    unit="pcs"
                    value={sc.remains_pieces > 0 ? Number(sc.remains_value) : undefined}
                    dim={sc.remains_pieces === 0}
                    piecesPerPack={sc.pieces_per_pack ? Number(sc.pieces_per_pack) : null}
                  />
                </React.Fragment>
              );
            })}
          </Section>
        );
      })()}

      {/* Raw ingredients (recipe-linked) */}
      {recipeIngredients.length > 0 && (
        <Section title="Raw ingredients" subtitle="System-tracked balance after today's prep">
          {recipeIngredients
            .sort((a, b) => a.ingredient_display_name.localeCompare(b.ingredient_display_name))
            .map((r) => (
              <StockRow
                key={r.id}
                name={r.ingredient_display_name}
                qty={Number(r.quantity_available)}
                unit={r.base_unit}
                value={rawValue(r) > 0 ? rawValue(r) : undefined}
                dim={Number(r.quantity_available) <= 0}
                piecesPerPack={r.pieces_per_pack ? Number(r.pieces_per_pack) : null}
              />
            ))}
        </Section>
      )}

      {/* Packaging & supplies (periodic count) */}
      {periodicIngredients.length > 0 && (
        <Section title="Packaging & supplies" subtitle="Last reported count">
          {periodicIngredients
            .sort((a, b) => a.ingredient_display_name.localeCompare(b.ingredient_display_name))
            .map((r) => (
              <StockRow
                key={r.id}
                name={r.ingredient_display_name}
                qty={Number(r.quantity_available)}
                unit={r.base_unit}
                value={rawValue(r) > 0 ? rawValue(r) : undefined}
                dim={Number(r.quantity_available) <= 0}
                piecesPerPack={r.pieces_per_pack ? Number(r.pieces_per_pack) : null}
              />
            ))}
        </Section>
      )}

      <button className="btn btn-ghost" onClick={() => router.push("/staff/closing")}>
        Back to checklist
      </button>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-[#d8cdb0] bg-paper overflow-hidden">
      <div className="px-3 py-2 bg-[#f5f0e8] border-b border-dashed border-[#d8cdb0]">
        <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-soft/60">{title}</p>
        <p className="font-mono text-[10px] text-ink-soft/50">{subtitle}</p>
      </div>
      <div className="divide-y divide-dashed divide-[#e8dfc8]">{children}</div>
    </div>
  );
}

function fmtPack(qty: number, piecesPerPack: number | null): string | null {
  if (!piecesPerPack || piecesPerPack <= 1 || qty <= 0) return null;
  const packs = Math.floor(qty / piecesPerPack);
  if (packs === 0) return null;
  const rem = qty % piecesPerPack;
  return rem === 0 ? `${packs} pk` : `${packs} pk · ${rem}`;
}

function StockRow({
  name,
  qty,
  unit,
  value,
  dim,
  piecesPerPack,
}: {
  name: string;
  qty: number;
  unit: string;
  value?: number;
  dim?: boolean;
  piecesPerPack?: number | null;
}) {
  const packLine = fmtPack(qty, piecesPerPack ?? null);
  return (
    <div className={`flex items-center justify-between px-3 py-2.5 ${dim ? "opacity-40" : ""}`}>
      <span className="font-display text-sm font-bold text-ink leading-tight truncate mr-3">
        {name}
      </span>
      <div className="shrink-0 flex flex-col items-end">
        <div className="flex items-baseline gap-1.5">
          <span className={`font-mono text-sm font-bold ${dim ? "text-ink-soft" : "text-ink"}`}>
            {qty % 1 === 0 ? qty : qty.toFixed(2)}
          </span>
          <span className="font-mono text-[10px] text-ink-soft">{unit}</span>
          {value !== undefined && value > 0 && (
            <>
              <span className="font-mono text-[10px] text-ink-soft/40">·</span>
              <span className="font-mono text-[10px] font-semibold text-gold-deep">{bdt(value)}</span>
            </>
          )}
        </div>
        {packLine && (
          <span className="font-mono text-[9px] text-ink-soft/50 leading-tight">
            {packLine}
          </span>
        )}
      </div>
    </div>
  );
}
