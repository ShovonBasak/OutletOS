"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { bdt, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type { DailyClosing } from "@/lib/types";

interface ProductRow {
  id: number;
  name: string;
  walkin: number;
  walkinRevenue: number;
  online: number;
  onlineRevenue: number;
  wastage: number;
  wastageCost: number;
  flag: boolean;
}

function StatChip({
  label,
  primary,
  secondary,
  color,
}: {
  label: string;
  primary: string;
  secondary?: string;
  color?: "leaf" | "chili" | "default";
}) {
  const primaryColor =
    color === "leaf" ? "text-leaf-deep" : color === "chili" ? "text-chili-deep" : "text-ink";
  return (
    <div className="ticket-chip flex flex-1 flex-col items-center text-center">
      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">{label}</span>
      <span className={`font-mono text-base font-bold leading-tight ${primaryColor}`}>{primary}</span>
      {secondary && (
        <span className="font-mono text-[10px] text-ink-soft/70">{secondary}</span>
      )}
    </div>
  );
}

export default function SalesSummaryScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();
  const [closing, setClosing] = useState<DailyClosing | null>(null);

  useEffect(() => {
    getOrCreateTodayClosing(outlet, opDate).then(setClosing);
  }, [outlet, opDate]);

  if (!closing) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  const walkinLines = closing.sales_lines.filter((l) => l.source === "SYSTEM_DERIVED");
  const onlineLines = closing.sales_lines.filter((l) => l.source === "STAFF_ENTRY");

  // Build per-product rows. Prefer stock_counts (post-count-step derived data);
  // fall back to sales_lines directly when no counts have been entered yet (e.g. imported historical days).
  let rows: ProductRow[];
  if (closing.stock_counts.length > 0) {
    rows = closing.stock_counts.map((sc) => {
      const wl = walkinLines.find((l) => l.product === sc.product);
      const ol = onlineLines.find((l) => l.product === sc.product);
      return {
        id: sc.product,
        name: sc.product_name,
        walkin: sc.derived_walkin_sold,
        walkinRevenue: wl ? Number(wl.net_amount) : 0,
        online: sc.app_channel_sold,
        onlineRevenue: ol ? Number(ol.net_amount) : 0,
        wastage: sc.wastage_pieces,
        wastageCost: Number(sc.wastage_cost) || 0,
        flag: sc.flag,
      };
    });
  } else {
    // No count entries yet — build rows directly from sales_lines
    const productMap = new Map<number, ProductRow>();
    for (const l of walkinLines) {
      const row = productMap.get(l.product) ?? {
        id: l.product, name: l.product_name,
        walkin: 0, walkinRevenue: 0,
        online: 0, onlineRevenue: 0,
        wastage: 0, wastageCost: 0, flag: false,
      };
      row.walkin += l.quantity_sold;
      row.walkinRevenue += Number(l.net_amount);
      productMap.set(l.product, row);
    }
    for (const l of onlineLines) {
      const row = productMap.get(l.product) ?? {
        id: l.product, name: l.product_name,
        walkin: 0, walkinRevenue: 0,
        online: 0, onlineRevenue: 0,
        wastage: 0, wastageCost: 0, flag: false,
      };
      row.online += l.quantity_sold;
      row.onlineRevenue += Number(l.net_amount);
      productMap.set(l.product, row);
    }
    rows = Array.from(productMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  const totalWalkinRevenue = walkinLines.reduce((s, l) => s + Number(l.net_amount), 0);
  const totalOnlineRevenue = onlineLines.reduce((s, l) => s + Number(l.net_amount), 0);
  const totalWalkinQty = rows.reduce((s, r) => s + Math.max(0, r.walkin), 0);
  const totalOnlineQty = rows.reduce((s, r) => s + r.online, 0);
  const totalWastage = rows.reduce((s, r) => s + r.wastage, 0);
  const totalWastageCost = rows.reduce((s, r) => s + r.wastageCost, 0);
  const hasFlags = rows.some((r) => r.flag);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Sales summary</h1>
        <p className="text-xs text-ink-soft">
          {closing.stock_counts.length > 0
            ? "Step 3 · view-only — derived from your count entries"
            : "Step 3 · view-only — sales recorded for this day"}
        </p>
      </div>

      {/* Summary chips */}
      <div className="flex gap-2">
        <StatChip
          label="Walk-in"
          primary={bdt(totalWalkinRevenue)}
          secondary={`${totalWalkinQty} pcs`}
          color="leaf"
        />
        <StatChip
          label="Online"
          primary={bdt(totalOnlineRevenue)}
          secondary={`${totalOnlineQty} pcs`}
          color="leaf"
        />
        <StatChip
          label="Wastage"
          primary={totalWastageCost > 0 ? bdt(totalWastageCost) : `${totalWastage} pcs`}
          secondary={totalWastageCost > 0 ? `${totalWastage} pcs` : undefined}
          color={totalWastage > 0 ? "chili" : "default"}
        />
      </div>

      {/* Flag warning */}
      {hasFlags && (
        <div className="rounded border border-chili/40 bg-chili/10 px-3 py-2.5 font-mono text-[11px] text-chili-deep">
          ⚑ One or more products have a negative walk-in — check your count entries. Owner review required.
        </div>
      )}

      {/* Per-product breakdown */}
      {rows.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">
          No sales recorded yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className={`ticket overflow-hidden !p-0 ${row.flag ? "border-chili/60" : ""}`}
            >
              {/* Product name header */}
              <div className={`flex items-center justify-between px-3 py-2 ${row.flag ? "bg-chili/5" : "bg-[#f5f0e8]"}`}>
                <span className="font-display text-sm font-bold text-ink">{row.name}</span>
                {row.flag && (
                  <span className="font-mono text-[10px] font-semibold text-chili-deep">
                    ⚑ negative walk-in
                  </span>
                )}
              </div>

              {/* Three-column breakdown */}
              <div className="grid grid-cols-3 divide-x divide-dashed divide-[#d8cdb0]">
                {/* Walk-in */}
                <div className="flex flex-col items-center px-2 py-2.5">
                  <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft/70">
                    Walk-in
                  </span>
                  <span className={`font-mono text-xl font-bold leading-tight ${
                    row.walkin < 0 ? "text-chili" : "text-leaf-deep"
                  }`}>
                    {row.walkin}
                  </span>
                  <span className="font-mono text-[10px] text-ink-soft">
                    {row.walkinRevenue > 0 ? bdt(row.walkinRevenue) : "—"}
                  </span>
                </div>

                {/* Online */}
                <div className="flex flex-col items-center px-2 py-2.5">
                  <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft/70">
                    Online
                  </span>
                  <span className="font-mono text-xl font-bold leading-tight text-ink">
                    {row.online}
                  </span>
                  <span className="font-mono text-[10px] text-ink-soft">
                    {row.onlineRevenue > 0 ? bdt(row.onlineRevenue) : "—"}
                  </span>
                </div>

                {/* Wastage */}
                <div className="flex flex-col items-center px-2 py-2.5">
                  <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft/70">
                    Wastage
                  </span>
                  <span className={`font-mono text-xl font-bold leading-tight ${
                    row.wastage > 0 ? "text-chili-deep" : "text-ink-soft/40"
                  }`}>
                    {row.wastage}
                  </span>
                  <span className={`font-mono text-[10px] ${row.wastageCost > 0 ? "text-chili-deep" : "text-ink-soft/40"}`}>
                    {row.wastageCost > 0 ? bdt(row.wastageCost) : "pcs"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary ticket */}
      {rows.length > 0 && (
        <div className="ticket">
          <div className="ticket-row font-semibold">
            <span>Walk-in revenue</span>
            <span className="text-leaf-deep">{bdt(totalWalkinRevenue)}</span>
          </div>
          <div className="ticket-row font-semibold">
            <span>Online revenue</span>
            <span className="text-leaf-deep">{bdt(totalOnlineRevenue)}</span>
          </div>
          <div className="ticket-total">
            <span>Total revenue</span>
            <span>{bdt(totalWalkinRevenue + totalOnlineRevenue)}</span>
          </div>

          {/* Wastage cost — separated visually; not part of revenue */}
          <div className="mt-3 border-t border-dashed border-[#d8cdb0] pt-3">
            <div className="ticket-row">
              <span className="text-ink-soft">
                Wastage cost
                <span className="ml-1 font-mono text-[9px] uppercase tracking-wide">(not in revenue)</span>
              </span>
              <span className="text-chili-deep">{bdt(totalWastageCost)}</span>
            </div>
            <div className="ticket-row text-[11px] text-ink-soft/60">
              <span>{totalWastage} pcs lost</span>
            </div>
          </div>
        </div>
      )}

      <button className="btn btn-ghost" onClick={() => router.push("/staff/closing")}>
        Back to checklist
      </button>
    </div>
  );
}
