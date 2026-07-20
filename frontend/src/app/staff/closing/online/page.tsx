"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { ProductListFilter } from "@/components/ProductListFilter";
import type { DailyClosing, Paginated, Product, SalesChannel } from "@/lib/types";

export default function OnlineSellScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const outlet = user?.outlet ?? 1;
  const [products, setProducts] = useState<Product[]>([]);
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  // qty[productId][channelId] = string
  const [qty, setQty] = useState<Record<number, Record<number, string>>>({});
  const [discounts, setDiscounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const c = await getOrCreateTodayClosing(outlet);
      setClosing(c);
      const [p, ch] = await Promise.all([
        api<Paginated<Product>>("/products/?active=true"),
        api<Paginated<SalesChannel>>("/sales-channels/"),
      ]);
      setProducts(p.results);
      const appChannels = ch.results.filter(
        (x) => x.is_active && x.name.toLowerCase() !== "walk-in"
      );
      setChannels(appChannels);

      const seedQty: Record<number, Record<number, string>> = {};
      for (const line of c.sales_lines.filter((l) => l.source === "STAFF_ENTRY")) {
        seedQty[line.product] = seedQty[line.product] || {};
        seedQty[line.product][line.channel] = String(line.quantity_sold);
      }
      setQty(seedQty);
      const seedDisc: Record<number, string> = {};
      for (const d of c.channel_discounts) seedDisc[d.channel] = String(d.discount_amount);
      setDiscounts(seedDisc);
    })();
  }, [outlet]);

  function set(pid: number, cid: number, val: string) {
    setQty((q) => ({ ...q, [pid]: { ...(q[pid] || {}), [cid]: val } }));
  }

  const rowTotal = (pid: number) =>
    channels.reduce((s, c) => s + Number(qty[pid]?.[c.id] || 0), 0);

  async function save() {
    if (!closing) return;
    setBusy(true);
    const items: { product: number; channel: number; quantity_sold: number }[] = [];
    for (const p of products) {
      for (const c of channels) {
        const v = Number(qty[p.id]?.[c.id] || 0);
        if (v > 0) items.push({ product: p.id, channel: c.id, quantity_sold: v });
      }
    }
    const discItems = channels
      .filter((c) => Number(discounts[c.id] || 0) > 0)
      .map((c) => ({ channel: c.id, discount_amount: Number(discounts[c.id]) }));
    try {
      await api(`/daily-closings/${closing.id}/online-sell/`, {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      if (discItems.length) {
        await api(`/daily-closings/${closing.id}/channel-discounts/`, {
          method: "POST",
          body: JSON.stringify({ items: discItems }),
        });
      }
      router.push("/staff/closing");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Online sell</h1>
        <p className="text-xs text-ink-soft">Step 2 · Pathao / Foodi / Foodpanda quantities</p>
      </div>

      <div
        className="grid gap-1 px-1 font-mono text-[9px] uppercase tracking-wide text-ink-soft"
        style={{ gridTemplateColumns: `1fr repeat(${channels.length}, 48px)` }}
      >
        <span>Product</span>
        {channels.map((c) => (
          <span key={c.id} className="text-center">
            {c.name.slice(0, 5)}
          </span>
        ))}
      </div>

      <ProductListFilter
        products={products}
        isDone={(p) => rowTotal(p.id) > 0}
        doneLabel={(d, t) => `${d}/${t} with sales`}
        renderRow={(p) => (
          <div
            className="grid items-center gap-1"
            style={{ gridTemplateColumns: `1fr repeat(${channels.length}, 48px)` }}
          >
            <span className="font-mono text-xs">{p.name}</span>
            {channels.map((c) => (
              <input
                key={c.id}
                className="field-input !px-1 !py-1 text-center"
                inputMode="numeric"
                value={qty[p.id]?.[c.id] ?? ""}
                onChange={(e) => set(p.id, c.id, e.target.value)}
              />
            ))}
          </div>
        )}
      />

      <div className="ticket">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-soft">
          Per-channel discount (off the app&apos;s daily summary)
        </p>
        {channels.map((c) => (
          <div key={c.id} className="mb-2 flex items-center gap-2">
            <span className="flex-1 font-mono text-xs">{c.name}</span>
            <span className="font-mono text-[10px] text-ink-soft">৳</span>
            <input
              className="field-input w-24"
              inputMode="numeric"
              placeholder="0"
              value={discounts[c.id] ?? ""}
              onChange={(e) => setDiscounts((d) => ({ ...d, [c.id]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <button className="btn btn-primary" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save & back to checklist"}
      </button>
    </div>
  );
}
