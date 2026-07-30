"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type { DailyClosing, DisplayStock, Paginated, Product, SalesChannel } from "@/lib/types";

export default function OnlineSellScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();

  const [products, setProducts] = useState<Product[]>([]);
  const [channel, setChannel] = useState<SalesChannel | null>(null);
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [maxQty, setMaxQty] = useState<Record<number, number>>({});
  const [discount, setDiscount] = useState("0");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [busy, setBusy] = useState(false);

  // Refs so debounced persist always sees latest values.
  const closingRef = useRef<DailyClosing | null>(null);
  const channelRef = useRef<SalesChannel | null>(null);
  const discountRef = useRef("0");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      const c = await getOrCreateTodayClosing(outlet, opDate);
      setClosing(c);
      closingRef.current = c;

      const [p, ch, ds] = await Promise.all([
        api<Paginated<Product>>("/products/?active=true"),
        api<Paginated<SalesChannel>>("/sales-channels/"),
        api<Paginated<DisplayStock>>(`/display-stock/?outlet=${outlet}`),
      ]);
      const dsMap: Record<number, number> = {};
      ds.results.forEach((d) => { dsMap[d.product] = d.pieces_available; });
      setMaxQty(dsMap);

      // Only show products that have been prepared today.
      setProducts(p.results.filter((prod) => (dsMap[prod.id] ?? 0) > 0));

      const fp = ch.results.find(
        (x) => x.is_active && x.name.toLowerCase().includes("foodpanda")
      ) ?? null;
      setChannel(fp);
      channelRef.current = fp;

      if (fp) {
        const seed: Record<number, number> = {};
        const staleItems: { product: number; channel: number; quantity_sold: number }[] = [];
        for (const l of c.sales_lines.filter(
          (l) => l.source === "STAFF_ENTRY" && l.channel === fp.id
        )) {
          if ((dsMap[l.product] ?? 0) > 0) {
            seed[l.product] = l.quantity_sold;
          } else {
            staleItems.push({ product: l.product, channel: fp.id, quantity_sold: 0 });
          }
        }
        if (staleItems.length) {
          await api(`/daily-closings/${c.id}/online-sell/`, {
            method: "POST",
            body: JSON.stringify({ items: staleItems }),
          });
        }
        setQty(seed);

        const disc = c.channel_discounts.find((d) => d.channel === fp.id);
        const discVal = disc ? String(disc.discount_amount) : "0";
        setDiscount(discVal);
        discountRef.current = discVal;
      }
    })();
  }, [outlet, opDate]);

  async function persist(currentQty: Record<number, number>, currentDiscount: string) {
    const c = closingRef.current;
    const ch = channelRef.current;
    if (!c || !ch) return;
    setSaveStatus("saving");
    try {
      const items = Object.entries(currentQty)
        .map(([pid, v]) => ({ product: Number(pid), channel: ch.id, quantity_sold: v }));
      await api(`/daily-closings/${c.id}/online-sell/`, {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      const discAmt = Number(currentDiscount || 0);
      await api(`/daily-closings/${c.id}/channel-discounts/`, {
        method: "POST",
        body: JSON.stringify({
          items: discAmt > 0 ? [{ channel: ch.id, discount_amount: discAmt }] : [],
        }),
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("idle");
    }
  }

  function scheduleSave(nextQty: Record<number, number>) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => persist(nextQty, discountRef.current), 600);
  }

  function adjust(pid: number, delta: number) {
    setQty((prev) => {
      const max = maxQty[pid] ?? 0;
      const next = { ...prev, [pid]: Math.min(max, Math.max(0, (prev[pid] ?? 0) + delta)) };
      scheduleSave(next);
      return next;
    });
  }

  async function finish() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setBusy(true);
    await persist(qty, discountRef.current);
    setBusy(false);
    router.push("/staff/closing");
  }

  const totalOrders = Object.values(qty).reduce((s, v) => s + v, 0);

  if (!channel) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-xl font-bold">Online sell</h1>
        <p className="font-mono text-xs text-ink-soft">
          No Foodpanda channel found. Ask the owner to add it in settings.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-xl font-bold">Online sell</h1>
          <p className="text-xs text-ink-soft">Step 2 · Foodpanda · tap + after each order</p>
        </div>
        <span className={`font-mono text-[10px] transition-opacity ${
          saveStatus === "saving" ? "text-ink-soft" :
          saveStatus === "saved"  ? "text-leaf-deep" : "opacity-0"
        }`}>
          {saveStatus === "saving" ? "Saving…" : "Saved ✓"}
        </span>
      </div>

      {/* Total pill */}
      <div className="flex items-center justify-between rounded bg-paper-dim px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">
          Total orders today
        </span>
        <span className="num font-semibold">{totalOrders}</span>
      </div>

      {/* Product list — stable order, never reorders on tap */}
      <div className="flex flex-col divide-y divide-dotted divide-[#d8cdb0]">
        {products.map((p) => (
          <ProductRow
            key={p.id}
            name={p.name}
            count={qty[p.id] ?? 0}
            max={maxQty[p.id] ?? 0}
            onAdjust={(d) => adjust(p.id, d)}
          />
        ))}
      </div>

      {/* Discount */}
      <div className="ticket">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
          Foodpanda discount (off the app&apos;s daily summary)
        </p>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-ink-soft">৳</span>
          <input
            className="field-input w-32"
            inputMode="numeric"
            placeholder="0"
            value={discount}
            onChange={(e) => {
              setDiscount(e.target.value);
              discountRef.current = e.target.value;
              scheduleSave(qty);
            }}
          />
        </div>
      </div>

      <button className="btn btn-primary" disabled={busy} onClick={finish}>
        {busy ? "Saving…" : "Done — back to checklist"}
      </button>

    </div>
  );
}

function ProductRow({
  name,
  count,
  max,
  onAdjust,
}: {
  name: string;
  count: number;
  max: number;
  onAdjust: (delta: number) => void;
}) {
  const atMax = count >= max;
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex flex-col">
        <span className={`font-mono text-sm ${count > 0 ? "font-semibold text-ink" : "text-ink-soft"}`}>
          {name}
        </span>
        {max > 0 && (
          <span className="font-mono text-[10px] text-ink-soft/60">{max} prepared</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          className={`h-7 w-7 rounded-full border font-mono text-sm leading-none transition-opacity ${
            count > 0 ? "border-ink/40 opacity-100" : "border-transparent opacity-0 pointer-events-none"
          }`}
          onClick={() => onAdjust(-1)}
          tabIndex={count > 0 ? 0 : -1}
        >
          −
        </button>
        <span className={`num min-w-[1.5rem] text-center text-sm ${count > 0 ? "font-bold" : "text-ink-soft/30"}`}>
          {count}
        </span>
        <button
          disabled={atMax}
          className="h-7 w-7 rounded-full bg-chrome font-mono text-sm leading-none text-paper disabled:opacity-30"
          onClick={() => onAdjust(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}
