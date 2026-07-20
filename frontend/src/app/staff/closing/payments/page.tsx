"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { bdt2 } from "@/lib/format";
import type { DailyClosing } from "@/lib/types";

export default function PaymentsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const outlet = user?.outlet ?? 1;
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [bkash, setBkash] = useState("0");
  const [card, setCard] = useState("0");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getOrCreateTodayClosing(outlet).then((c) => {
      setClosing(c);
      const b = c.payments.find((p) => p.method === "BKASH");
      const cd = c.payments.find((p) => p.method === "CARD");
      if (b) setBkash(String(b.amount));
      if (cd) setCard(String(cd.amount));
    });
  }, [outlet]);

  async function recompute(nextBkash = bkash, nextCard = card) {
    if (!closing) return;
    setBusy(true);
    try {
      const c = await api<DailyClosing>(`/daily-closings/${closing.id}/payments/`, {
        method: "POST",
        body: JSON.stringify({ bkash: Number(nextBkash || 0), card: Number(nextCard || 0) }),
      });
      setClosing(c);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (closing) recompute("0", "0");
    // run once after load to populate computed cash
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing?.id]);

  if (!closing) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  const cash = closing.payments.find((p) => p.method === "CASH")?.amount ?? closing.computed_cash;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Payments</h1>
        <p className="text-xs text-ink-soft">Step 4 · cash is computed, not typed</p>
      </div>

      <div className="ticket">
        <div className="ticket-row">
          <span>Total sale (all channels)</span>
          <span>{bdt2(closing.total_sale)}</span>
        </div>
        <div className="ticket-row">
          <span>− Online (direct to account)</span>
          <span>{bdt2(closing.online_payments)}</span>
        </div>
        <div className="ticket-total">
          <span>Total offline sales</span>
          <span>{bdt2(closing.total_offline_sales)}</span>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="field-label">bKash (৳)</span>
        <input
          className="field-input"
          inputMode="numeric"
          value={bkash}
          onChange={(e) => setBkash(e.target.value)}
          onBlur={() => recompute()}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="field-label">Card (৳)</span>
        <input
          className="field-input"
          inputMode="numeric"
          value={card}
          onChange={(e) => setCard(e.target.value)}
          onBlur={() => recompute()}
        />
      </label>

      <div className="rounded bg-action px-4 py-3 text-gold">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wide">Cash (computed)</span>
          <span className="num text-lg font-semibold">{bdt2(cash)}</span>
        </div>
        <p className="mt-1 font-mono text-[10px] text-gold/70">
          = offline sales − bKash − card
        </p>
      </div>

      <button className="btn btn-ghost" disabled={busy} onClick={() => router.push("/staff/closing")}>
        {busy ? "Saving…" : "Save & back to checklist"}
      </button>
    </div>
  );
}
