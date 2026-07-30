"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import { ProductListFilter } from "@/components/ProductListFilter";
import type { DailyClosing, DisplayStock, Paginated, Product } from "@/lib/types";

interface Row {
  wastage_pieces: string;
  remains_pieces: string;
}

export default function CountScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();
  const [products, setProducts] = useState<Product[]>([]);
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [displayStock, setDisplayStock] = useState<Record<number, number>>({});
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [c, p, ds] = await Promise.all([
        getOrCreateTodayClosing(outlet, opDate),
        api<Paginated<Product>>("/products/?active=true&product_type=SINGLE"),
        api<Paginated<DisplayStock>>(`/display-stock/?outlet=${outlet}`),
      ]);
      setClosing(c);

      const dsMap: Record<number, number> = {};
      ds.results.forEach((d) => { dsMap[d.product] = d.pieces_available; });
      setDisplayStock(dsMap);

      const countedIds = new Set(c.stock_counts.map((s) => s.product));
      // Only show products that were prepared today or already have a count entry.
      const prepared = p.results.filter(
        (prod) => (dsMap[prod.id] ?? 0) > 0 || countedIds.has(prod.id)
      );
      setProducts(prepared);

      const seed: Record<number, Row> = {};
      for (const prod of prepared) {
        const existing = c.stock_counts.find((s) => s.product === prod.id);
        seed[prod.id] = {
          wastage_pieces: existing ? String(existing.wastage_pieces) : "0",
          remains_pieces: existing ? String(existing.remains_pieces) : "0",
        };
      }
      setRows(seed);
    })();
  }, [outlet, opDate]);

  function set(pid: number, key: keyof Row, val: string) {
    setRows((r) => ({ ...r, [pid]: { ...r[pid], [key]: val } }));
  }

  const isDone = (p: Product) => {
    const r = rows[p.id];
    return !!r && r.remains_pieces !== "";
  };

  async function save() {
    if (!closing) return;
    setBusy(true);
    const items = products
      .filter(isDone)
      .map((p) => ({
        product: p.id,
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
        <p className="text-xs text-ink-soft">Step 1 · enter wastage and remains for each item</p>
      </div>

      <div className="rounded border border-leaf/40 bg-leaf/10 px-3 py-2 text-xs text-ink-soft">
        <p><span className="font-semibold">Available</span> is filled by the system from today&apos;s prep. You only count:</p>
        <p className="mt-0.5"><span className="font-semibold">Waste</span> — pieces being binned now &nbsp;·&nbsp; <span className="font-semibold">Remains</span> — pieces left over (counter / shelf)</p>
      </div>

      <div className="grid grid-cols-[1fr_40px_44px_44px] gap-1 px-1 font-mono text-[9px] uppercase tracking-wide text-ink-soft">
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
          const r = rows[p.id] ?? { wastage_pieces: "0", remains_pieces: "0" };
          const available = displayStock[p.id] ?? 0;
          const waste = Number(r.wastage_pieces || 0);
          const remains = Number(r.remains_pieces || 0);
          const impliedSold = available - waste - remains;
          const flagged = r.remains_pieces !== "" && impliedSold < 0;
          return (
            <div className="flex flex-col gap-0.5">
              <div className="grid grid-cols-[1fr_40px_44px_44px] items-center gap-1">
                <span className="font-mono text-xs">{p.name}</span>
                {/* Available — system value, read-only */}
                <span className="text-center font-mono text-xs text-ink-soft">{available}</span>
                <input
                  className="field-input !px-1 !py-1 text-center"
                  inputMode="numeric"
                  value={r.wastage_pieces}
                  onChange={(e) => set(p.id, "wastage_pieces", e.target.value)}
                />
                <input
                  className={`field-input !px-1 !py-1 text-center ${flagged ? "border-chili" : ""}`}
                  inputMode="numeric"
                  value={r.remains_pieces}
                  onChange={(e) => set(p.id, "remains_pieces", e.target.value)}
                />
              </div>
              {r.remains_pieces !== "" && (
                <p className={`pl-1 font-mono text-[10px] ${flagged ? "text-chili" : "text-ink-soft/60"}`}>
                  {flagged
                    ? `⚠ waste + remains (${waste + remains}) exceeds available (${available})`
                    : `walk-in sold ≈ ${impliedSold}`}
                </p>
              )}
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
