"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  confirmDayStartStock,
  fetchDayStartStock,
} from "@/lib/operatingDay";
import { useOperatingDay } from "@/lib/staffDay";
import { packBreakdown } from "@/lib/format";
import type { DayStartStockRow, DiscrepancyReason } from "@/lib/types";
import { INGREDIENT_GROUPS } from "@/lib/types";

const REASONS: { value: DiscrepancyReason; label: string }[] = [
  { value: "SPOILED", label: "Spoiled" },
  { value: "MISCOUNTED_YESTERDAY", label: "Miscounted yesterday" },
  { value: "SURPLUS_FOUND", label: "Surplus found" },
  { value: "OTHER", label: "Other" },
];

export default function DayStartStock() {
  const { day, refreshDay } = useOperatingDay();
  const router = useRouter();
  const [rows, setRows] = useState<DayStartStockRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (day) fetchDayStartStock(day.id).then(setRows);
  }, [day]);

  function setConfirmed(i: number, value: number) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, confirmed_qty: value } : row)));
  }
  function setReason(i: number, value: DiscrepancyReason) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, discrepancy_reason: value } : row)));
  }
  function setNote(i: number, value: string) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, note: value } : row)));
  }
  function replicate() {
    setRows((r) => r.map((row) => ({ ...row, confirmed_qty: row.system_carried_qty, discrepancy_reason: "" as DiscrepancyReason, note: "" })));
  }

  async function submit() {
    setErr("");
    const missing = rows.find(
      (r) => Number(r.system_carried_qty) !== Number(r.confirmed_qty) && !r.discrepancy_reason
    );
    if (missing) {
      setErr(`"${missing.ingredient_display_name}" has a discrepancy — pick a reason.`);
      return;
    }
    setBusy(true);
    try {
      await confirmDayStartStock(day!.id, rows);
      await refreshDay();
      router.push("/staff/prep/carry-forward");
    } catch {
      setErr("Could not save — check your entries.");
    } finally {
      setBusy(false);
    }
  }

  if (!day) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  const flaggedCount = rows.filter(
    (r) => Number(r.system_carried_qty) !== Number(r.confirmed_qty)
  ).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Day-start stock</h1>
        <p className="text-xs text-ink-soft">
          Confirm the ingredient stock carried from yesterday. Any mismatch needs a reason.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <button className="chip chip-active self-start" onClick={replicate}>
          ↺ Accept all (replicate system)
        </button>
        {flaggedCount > 0 && (
          <span className="font-mono text-[11px] text-chili">
            {flaggedCount} mismatch{flaggedCount > 1 ? "es" : ""}
          </span>
        )}
      </div>

      {[...INGREDIENT_GROUPS, { key: "Supply", icon: "📦" }].map(({ key, icon }) => {
        const groupRows = rows
          .map((row, i) => ({ row, i }))
          .filter(({ row }) => row.ingredient_group === key)
          .sort(
            (a, b) =>
              a.row.primary_product.localeCompare(b.row.primary_product) ||
              a.row.ingredient_display_name.localeCompare(b.row.ingredient_display_name)
          );
        if (groupRows.length === 0) return null;

        const flaggedInGroup = groupRows.filter(({ row }) =>
          Number(row.system_carried_qty) !== Number(row.confirmed_qty)
        ).length;

        return (
          <div key={key} className="rounded border border-[#d8cdb0] bg-paper overflow-hidden">
            {/* Group header */}
            <div className="flex items-center justify-between px-3 py-2 bg-[#f5f0e8] border-b border-dashed border-[#d8cdb0]">
              <div className="flex items-center gap-1.5">
                <span className="text-sm">{icon}</span>
                <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-soft/60">
                  {key}
                </p>
                <span className="font-mono text-[9px] text-ink-soft/40">
                  · {groupRows.length}
                </span>
              </div>
              {flaggedInGroup > 0 && (
                <span className="font-mono text-[9px] text-chili">
                  {flaggedInGroup} mismatch{flaggedInGroup > 1 ? "es" : ""}
                </span>
              )}
            </div>

            {/* Items */}
            <div className="divide-y divide-dashed divide-[#e8dfc8]">
              {groupRows.map(({ row, i }) => {
                const diff = Number(row.system_carried_qty) - Number(row.confirmed_qty);
                const flagged = diff !== 0;
                const systemPacks = packBreakdown(row.system_carried_qty, row.pieces_per_pack, row.base_unit);
                const countedPacks = packBreakdown(row.confirmed_qty, row.pieces_per_pack, row.base_unit);

                return (
                  <div
                    key={row.ingredient}
                    className={`px-3 py-2.5 ${flagged ? "bg-chili/5" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-display text-sm font-bold">
                          {row.ingredient_display_name}
                        </span>
                        {row.ingredient_display_name !== row.ingredient_name && (
                          <p className="font-mono text-[9px] text-ink-soft/50 leading-tight mt-0.5 truncate">
                            {row.ingredient_name}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-mono text-[10px] text-ink-soft">
                          system {Number(row.system_carried_qty)} {row.base_unit}
                        </p>
                        {systemPacks && (
                          <p className="font-mono text-[10px] text-ink-soft/60">= {systemPacks}</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-1.5 flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="field-label">Counted</span>
                        <input
                          type="number"
                          className="field-input w-24"
                          value={row.confirmed_qty}
                          onChange={(e) => setConfirmed(i, Number(e.target.value))}
                        />
                        <span className="font-mono text-[11px] text-ink-soft">{row.base_unit}</span>
                        {flagged && (
                          <span className="font-mono text-[10px] text-chili">
                            Δ {diff > 0 ? "−" : "+"}{Math.abs(diff)}
                          </span>
                        )}
                      </div>
                      {countedPacks && (
                        <p className="font-mono text-[10px] text-ink-soft/60 pl-[3.75rem]">
                          = {countedPacks}
                        </p>
                      )}
                    </div>

                    {flagged && (
                      <div className="mt-2 flex flex-col gap-1">
                        <select
                          className="field-input"
                          value={row.discrepancy_reason}
                          onChange={(e) => setReason(i, e.target.value as DiscrepancyReason)}
                        >
                          <option value="">Pick a reason…</option>
                          {REASONS.map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                        {row.discrepancy_reason === "OTHER" && (
                          <input
                            className="field-input"
                            placeholder="Note (required for Other)"
                            value={row.note}
                            onChange={(e) => setNote(i, e.target.value)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {rows.length === 0 && (
        <p className="font-mono text-xs text-ink-soft">No stock to check.</p>
      )}

      {err && <p className="font-mono text-xs text-chili-deep">{err}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? "Saving…" : "Confirm & continue →"}
      </button>
      <Link href="/staff" className="btn btn-ghost text-center">
        Back to home
      </Link>
    </div>
  );
}
