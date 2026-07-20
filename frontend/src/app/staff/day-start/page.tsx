"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  confirmDayStartStock,
  fetchDayStartStock,
} from "@/lib/operatingDay";
import { useOperatingDay } from "@/lib/staffDay";
import type { DayStartStockRow, DiscrepancyReason } from "@/lib/types";

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
    setRows((r) => r.map((row) => ({ ...row, confirmed_qty: row.system_carried_qty, discrepancy_reason: "", note: "" })));
  }

  async function submit() {
    setErr("");
    // Local guard mirrors the backend: any discrepancy needs a reason.
    const missing = rows.find(
      (r) => Number(r.system_carried_qty) !== Number(r.confirmed_qty) && !r.discrepancy_reason
    );
    if (missing) {
      setErr(`"${missing.ingredient_name}" has a discrepancy — pick a reason.`);
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

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Day-start stock</h1>
        <p className="text-xs text-ink-soft">
          Confirm the ingredient stock carried from yesterday. Any mismatch needs a reason.
        </p>
      </div>

      <button className="chip chip-active self-start" onClick={replicate}>
        ↺ Replicate all (accept system)
      </button>

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const diff = Number(row.system_carried_qty) - Number(row.confirmed_qty);
          const flagged = diff !== 0;
          return (
            <div
              key={row.ingredient}
              className={`rounded border px-3 py-2.5 ${
                flagged ? "border-chili/50 bg-chili/10" : "border-leaf/40 bg-leaf/10"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-bold">{row.ingredient_name}</span>
                <span className="font-mono text-[10px] text-ink-soft">
                  system {row.system_carried_qty} {row.base_unit}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
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
                    Δ {diff > 0 ? "−" : "+"}
                    {Math.abs(diff)}
                  </span>
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
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
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
