"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { bdt, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type { DailyClosing } from "@/lib/types";

interface ProductRow {
  id: number;
  name: string;
  requiresPreparation: boolean;
  piecesPerPack: number | null;
  walkin: number;
  walkinRevenue: number;
  online: number;
  onlineRevenue: number;
  wastage: number;
  wastageCost: number;
  remains: number;
  remainsValue: number;
  flag: boolean;
}

function fmtPack(qty: number, piecesPerPack: number | null): string | null {
  if (!piecesPerPack || piecesPerPack <= 1 || qty <= 0) return null;
  const packs = Math.floor(qty / piecesPerPack);
  if (packs === 0) return null;
  const rem = qty % piecesPerPack;
  return rem === 0 ? `${packs} pk` : `${packs} pk · ${rem}`;
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

  let rows: ProductRow[];
  if (closing.stock_counts.length > 0) {
    rows = closing.stock_counts.map((sc) => {
      const wl = walkinLines.find((l) => l.product === sc.product);
      const ol = onlineLines.find((l) => l.product === sc.product);
      return {
        id: sc.product,
        name: sc.product_name,
        requiresPreparation: sc.requires_preparation,
        piecesPerPack: sc.pieces_per_pack ? Number(sc.pieces_per_pack) : null,
        walkin: sc.derived_walkin_sold,
        walkinRevenue: wl ? Number(wl.net_amount) : 0,
        online: sc.app_channel_sold,
        onlineRevenue: ol ? Number(ol.net_amount) : 0,
        wastage: sc.wastage_pieces,
        wastageCost: Number(sc.wastage_cost) || 0,
        remains: sc.remains_pieces,
        remainsValue: Number(sc.remains_value) || 0,
        flag: sc.flag,
      };
    });
  } else {
    const productMap = new Map<number, ProductRow>();
    for (const l of walkinLines) {
      const row = productMap.get(l.product) ?? {
        id: l.product, name: l.product_name, requiresPreparation: false, piecesPerPack: null,
        walkin: 0, walkinRevenue: 0, online: 0, onlineRevenue: 0,
        wastage: 0, wastageCost: 0, remains: 0, remainsValue: 0, flag: false,
      };
      row.walkin += l.quantity_sold;
      row.walkinRevenue += Number(l.net_amount);
      productMap.set(l.product, row);
    }
    for (const l of onlineLines) {
      const row = productMap.get(l.product) ?? {
        id: l.product, name: l.product_name, requiresPreparation: false, piecesPerPack: null,
        walkin: 0, walkinRevenue: 0, online: 0, onlineRevenue: 0,
        wastage: 0, wastageCost: 0, remains: 0, remainsValue: 0, flag: false,
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
  const totalRemainsValue = rows.reduce((s, r) => s + (r.requiresPreparation ? r.remainsValue : 0), 0);
  const totalRemainsPcs = rows.reduce((s, r) => s + (r.requiresPreparation ? r.remains : 0), 0);
  const carriedForwardValue = Number(closing.carried_forward_value) || 0;
  const hasFlags = rows.some((r) => r.flag);

  // Sales summary only shows:
  //   - Any item that was actually sold (walk-in/online) or flagged
  //   - Prepared items that have wastage or unsold remains
  // Beverages with only remaining stock are excluded — they belong in Stock summary.
  const displayRows = rows.filter(
    (r) =>
      r.walkin > 0 ||
      r.online > 0 ||
      r.flag ||
      (r.requiresPreparation && (r.wastage > 0 || r.remains > 0))
  );

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

      {/* Revenue chips */}
      <div className="flex gap-2">
        <Chip
          label="Walk-in"
          primary={bdt(totalWalkinRevenue)}
          secondary={`${totalWalkinQty} pcs`}
          color="leaf"
        />
        <Chip
          label="Online"
          primary={bdt(totalOnlineRevenue)}
          secondary={`${totalOnlineQty} pcs`}
          color="leaf"
        />
        <Chip
          label="Wastage"
          primary={totalWastageCost > 0 ? bdt(totalWastageCost) : `${totalWastage} pcs`}
          secondary={totalWastageCost > 0 ? `${totalWastage} pcs` : undefined}
          color={totalWastage > 0 ? "chili" : "default"}
        />
      </div>

      {/* Carry-in / Carry-out panel */}
      <div className="rounded border border-[#d8cdb0] bg-paper divide-y divide-dashed divide-[#d8cdb0]">
        <div className="flex items-center justify-between px-3 py-2.5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">
              Brought from yesterday
            </p>
            <p className="font-mono text-[11px] text-ink-soft/60 mt-0.5">
              Carried-forward items at start of day
            </p>
          </div>
          <span className="font-mono text-sm font-bold text-ink">
            {carriedForwardValue > 0 ? bdt(carriedForwardValue) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">
              Remaining for tomorrow
            </p>
            <p className="font-mono text-[11px] text-ink-soft/60 mt-0.5">
              {totalRemainsPcs > 0 ? `${totalRemainsPcs} pcs to carry forward` : "Nothing left over"}
            </p>
          </div>
          <span className={`font-mono text-sm font-bold ${totalRemainsValue > 0 ? "text-gold-deep" : "text-ink-soft/40"}`}>
            {totalRemainsValue > 0 ? bdt(totalRemainsValue) : "—"}
          </span>
        </div>
      </div>

      {/* Flag warning */}
      {hasFlags && (
        <div className="rounded border border-chili/40 bg-chili/10 px-3 py-2.5 font-mono text-[11px] text-chili-deep">
          ⚑ One or more products have a negative walk-in — check your count entries. Owner review required.
        </div>
      )}

      {/* Per-product list */}
      {displayRows.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">No sales recorded yet.</p>
      ) : (
        <div className="rounded border border-[#d8cdb0] bg-paper overflow-hidden">
          <p className="px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-soft/60 bg-[#f5f0e8] border-b border-dashed border-[#d8cdb0]">
            By product
          </p>
          {displayRows.map((row, i) => {
            const totalSold = Math.max(0, row.walkin) + row.online;
            const totalRevenue = row.walkinRevenue + row.onlineRevenue;

            // Bottom-left channel breakdown — show raw walkin so flags surface the negative
            const channelParts: React.ReactNode[] = [];
            if (row.online > 0)
              channelParts.push(
                <span key="online" className="text-ink-soft">Online&nbsp;<span className="font-semibold text-ink">{row.online}</span></span>
              );
            if (row.walkin !== 0)
              channelParts.push(
                <span key="walkin" className={row.walkin < 0 ? "text-chili" : "text-ink-soft"}>
                  Walk-in&nbsp;<span className={`font-semibold ${row.walkin < 0 ? "text-chili" : "text-ink"}`}>{row.walkin}</span>
                </span>
              );
            if (channelParts.length === 0)
              channelParts.push(<span key="none" className="text-ink-soft/40">no channel data</span>);

            return (
              <div
                key={row.id}
                className={`px-3 py-2.5 ${
                  i < displayRows.length - 1 ? "border-b border-dashed border-[#e8dfc8]" : ""
                } ${row.flag ? "bg-chili/[0.03]" : ""}`}
              >
                {/* Top row: product name (left) · qty + price (right) */}
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    {row.flag && (
                      <span className="shrink-0 font-mono text-[10px] text-chili">⚑</span>
                    )}
                    <span className="font-display text-sm font-bold text-ink leading-tight truncate">
                      {row.name}
                    </span>
                  </div>
                  {/* Qty and price kept visually distinct: qty is monospace dark, price is green */}
                  <div className="shrink-0 flex items-baseline gap-0.5">
                    <span className={`font-mono text-sm font-bold ${row.flag ? "text-chili" : "text-ink"}`}>
                      {totalSold}
                    </span>
                    <span className="font-mono text-[10px] text-ink-soft mr-1">pcs</span>
                    <span className="font-mono text-[10px] text-ink-soft/40">·</span>
                    <span className="font-mono text-sm font-semibold text-leaf-deep ml-1">
                      {bdt(totalRevenue)}
                    </span>
                  </div>
                </div>

                {/* Bottom row: channel breakdown (left) · remaining (right) */}
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-mono text-[10px]">
                    {channelParts.map((part, j) => (
                      <span key={j} className="flex items-center gap-1.5">
                        {j > 0 && <span className="text-ink-soft/30">·</span>}
                        {part}
                      </span>
                    ))}
                    {row.wastage > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span className="text-ink-soft/30">·</span>
                        <span className="text-chili-deep">Wastage&nbsp;<span className="font-semibold">{row.wastage}</span></span>
                      </span>
                    )}
                  </div>
                  {row.requiresPreparation && (
                    <div className="shrink-0 flex flex-col items-end">
                      <span className={`font-mono text-[10px] ${row.remains > 0 ? "font-semibold text-gold-deep" : "text-ink-soft/30"}`}>
                        {row.remains > 0 ? `Rem ${row.remains}` : "—"}
                      </span>
                      {row.remains > 0 && fmtPack(row.remains, row.piecesPerPack) && (
                        <span className="font-mono text-[9px] text-ink-soft/50 leading-tight">
                          {fmtPack(row.remains, row.piecesPerPack)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Summary ticket */}
      {displayRows.length > 0 && (
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

          <div className="mt-3 border-t border-dashed border-[#d8cdb0] pt-3 flex flex-col gap-1">
            {totalWastageCost > 0 && (
              <div className="ticket-row text-[11px]">
                <span className="text-ink-soft">
                  Wastage cost
                  <span className="ml-1 font-mono text-[9px] uppercase tracking-wide">(not in revenue)</span>
                </span>
                <span className="text-chili-deep">{bdt(totalWastageCost)}</span>
              </div>
            )}
            {totalRemainsValue > 0 && (
              <div className="ticket-row text-[11px]">
                <span className="text-ink-soft">Stock carry-out value</span>
                <span className="text-gold-deep font-semibold">{bdt(totalRemainsValue)}</span>
              </div>
            )}
            {carriedForwardValue > 0 && (
              <div className="ticket-row text-[11px]">
                <span className="text-ink-soft">Stock carry-in value</span>
                <span className="text-ink">{bdt(carriedForwardValue)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <button className="btn btn-ghost" onClick={() => router.push("/staff/closing")}>
        Back to checklist
      </button>
    </div>
  );
}

function Chip({
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
      {secondary && <span className="font-mono text-[10px] text-ink-soft/70">{secondary}</span>}
    </div>
  );
}
