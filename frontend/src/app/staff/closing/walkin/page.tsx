"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { bdt, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type { DailyClosing } from "@/lib/types";

export default function WalkinScreen() {
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
  const total = walkinLines.reduce((s, l) => s + Number(l.net_amount), 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Walk-in</h1>
        <p className="text-xs text-ink-soft">
          Step 3 · view-only — derived from count minus wastage, remains & app sales
        </p>
      </div>

      <div className="ticket">
        {walkinLines.length === 0 && (
          <p className="font-mono text-xs text-ink-soft">
            No walk-in sales derived yet. Finish steps 1 &amp; 2 first.
          </p>
        )}
        {walkinLines.map((l) => (
          <div key={l.id} className="ticket-row">
            <span>
              {l.product_name} <span className="text-ink-soft">× {l.quantity_sold}</span>
            </span>
            <span>{bdt(l.net_amount)}</span>
          </div>
        ))}
        {walkinLines.length > 0 && (
          <div className="ticket-total">
            <span>Walk-in total</span>
            <span>{bdt(total)}</span>
          </div>
        )}
      </div>

      {closing.stock_counts.some((s) => s.flag) && (
        <div className="rounded border border-chili/40 bg-chili/10 p-3 font-mono text-[11px] text-chili-deep">
          ⚑ One or more products have negative derived walk-in — a miscount, unrecorded sale, or
          unlogged wastage. This closing will need owner review.
        </div>
      )}

      <button className="btn btn-ghost" onClick={() => router.push("/staff/closing")}>
        Back to checklist
      </button>
    </div>
  );
}
