"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { ProductListFilter } from "@/components/ProductListFilter";
import type { DailyClosing, Paginated, Product } from "@/lib/types";

interface Row {
  available_pieces: string;
  wastage_pieces: string;
  remains_pieces: string;
}

export default function CountScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const outlet = user?.outlet ?? 1;
  const [products, setProducts] = useState<Product[]>([]);
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const c = await getOrCreateTodayClosing(outlet);
      setClosing(c);
      const p = await api<Paginated<Product>>("/products/?active=true&product_type=SINGLE");
      setProducts(p.results);
      const seed: Record<number, Row> = {};
      for (const prod of p.results) {
        const existing = c.stock_counts.find((s) => s.product === prod.id);
        seed[prod.id] = {
          available_pieces: existing ? String(existing.available_pieces) : "",
          wastage_pieces: existing ? String(existing.wastage_pieces) : "0",
          remains_pieces: existing ? String(existing.remains_pieces) : "",
        };
      }
      setRows(seed);
    })();
  }, [outlet]);

  function set(pid: number, key: keyof Row, val: string) {
    setRows((r) => ({ ...r, [pid]: { ...r[pid], [key]: val } }));
  }

  const isDone = (p: Product) => {
    const r = rows[p.id];
    return !!r && r.available_pieces !== "" && r.remains_pieces !== "";
  };

  async function save() {
    if (!closing) return;
    setBusy(true);
    const items = products
      .filter(isDone)
      .map((p) => ({
        product: p.id,
        available_pieces: Number(rows[p.id].available_pieces || 0),
        wastage_pieces: Number(rows[p.id].wastage_pieces || 0),
        remains_pieces: Number(rows[p.id].remains_pieces || 0),
      }));
    try {
      await api(`/daily-closings/${closing.id}/stock-count/`, {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      router.push("/staff/closing");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Count remains & wastage</h1>
        <p className="text-xs text-ink-soft">Step 1 · enter available, wastage, remains</p>
      </div>

      <div className="grid grid-cols-[1fr_44px_44px_44px] gap-1 px-1 font-mono text-[9px] uppercase tracking-wide text-ink-soft">
        <span>Product</span>
        <span className="text-center">Avail</span>
        <span className="text-center">Waste</span>
        <span className="text-center">Remain</span>
      </div>

      <ProductListFilter
        products={products}
        isDone={isDone}
        doneLabel={(d, t) => `${d}/${t} counted`}
        renderRow={(p) => {
          const r = rows[p.id] ?? { available_pieces: "", wastage_pieces: "0", remains_pieces: "" };
          return (
            <div className="grid grid-cols-[1fr_44px_44px_44px] items-center gap-1">
              <span className="font-mono text-xs">{p.name}</span>
              <input
                className="field-input !px-1 !py-1 text-center"
                inputMode="numeric"
                value={r.available_pieces}
                onChange={(e) => set(p.id, "available_pieces", e.target.value)}
              />
              <input
                className="field-input !px-1 !py-1 text-center"
                inputMode="numeric"
                value={r.wastage_pieces}
                onChange={(e) => set(p.id, "wastage_pieces", e.target.value)}
              />
              <input
                className="field-input !px-1 !py-1 text-center"
                inputMode="numeric"
                value={r.remains_pieces}
                onChange={(e) => set(p.id, "remains_pieces", e.target.value)}
              />
            </div>
          );
        }}
      />

      <button className="btn btn-primary" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save & back to checklist"}
      </button>
    </div>
  );
}
