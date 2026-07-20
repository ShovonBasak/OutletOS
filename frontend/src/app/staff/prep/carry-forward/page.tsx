"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  confirmCarryForward,
  fetchCarryForward,
} from "@/lib/operatingDay";
import { useOperatingDay } from "@/lib/staffDay";
import type { CarryForwardRow } from "@/lib/types";

export default function CarryForward() {
  const { day, refreshDay } = useOperatingDay();
  const router = useRouter();
  const [rows, setRows] = useState<CarryForwardRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (day) fetchCarryForward(day.id).then((r) => {
      setRows(r);
      setLoaded(true);
    });
  }, [day]);

  function setMoved(i: number, value: number) {
    setRows((r) =>
      r.map((row, idx) =>
        idx === i
          ? { ...row, pieces_prepared: Math.max(0, Math.min(value, row.leftover_available_pieces)) }
          : row
      )
    );
  }

  async function submit() {
    setBusy(true);
    try {
      await confirmCarryForward(day!.id, rows);
      await refreshDay();
      router.push("/staff");
    } finally {
      setBusy(false);
    }
  }

  if (!day) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Move yesterday&apos;s leftovers</h1>
        <p className="text-xs text-ink-soft">
          Carry prepared items into today&apos;s stock. Move less and the rest is logged as wastage.
        </p>
      </div>

      {loaded && rows.length === 0 && (
        <div className="ticket">
          <p className="font-mono text-xs text-ink-soft">
            Nothing left over from yesterday — you&apos;re all set.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const wastage = row.leftover_available_pieces - row.pieces_prepared;
          return (
            <div key={row.stock_count} className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-bold">{row.product_name}</span>
                <span className="font-mono text-[10px] text-ink-soft">
                  leftover {row.leftover_available_pieces} pcs
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="field-label">Move</span>
                <input
                  type="number"
                  className="field-input w-24"
                  value={row.pieces_prepared}
                  onChange={(e) => setMoved(i, Number(e.target.value))}
                />
                <span className="font-mono text-[11px] text-ink-soft">pcs</span>
                {wastage > 0 && (
                  <span className="font-mono text-[10px] text-chili">→ {wastage} wasted</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? "Saving…" : rows.length ? "Confirm & unlock app →" : "Continue →"}
      </button>
      <Link href="/staff" className="btn btn-ghost text-center">
        Back to home
      </Link>
    </div>
  );
}
