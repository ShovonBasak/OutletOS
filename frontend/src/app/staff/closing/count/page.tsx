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
  remains: number;
  wastage: number;
}

function Stepper({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  max?: number;
}) {
  const atMax = max !== undefined && value >= max;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="w-16 font-mono text-[11px] uppercase tracking-wide text-ink-soft">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded border border-[#d8cdb0] bg-paper font-mono text-base text-ink active:bg-paper-dim disabled:opacity-40"
          onClick={() => onChange(Math.max(0, value - 1))}
          disabled={value <= 0}
        >
          −
        </button>
        <input
          className={`field-input h-9 !w-16 !px-0 text-center font-mono text-sm font-semibold ${atMax ? "!border-chili/50 !bg-chili/5" : ""}`}
          inputMode="numeric"
          value={value}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!isNaN(n) && n >= 0) onChange(max !== undefined ? Math.min(n, max) : n);
            else if (e.target.value === "") onChange(0);
          }}
        />
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded border border-[#d8cdb0] bg-paper font-mono text-base text-ink active:bg-paper-dim disabled:opacity-40"
          onClick={() => onChange(value + 1)}
          disabled={atMax}
        >
          +
        </button>
      </div>
    </div>
  );
}

function ReviewToggle({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={checked ? "Mark as not reviewed" : "Mark as reviewed"}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition-all active:scale-95 ${
        checked
          ? "border-leaf-deep bg-leaf-deep text-paper shadow-sm"
          : "border-dashed border-[#c5b99a] bg-transparent text-transparent"
      }`}
    >
      <svg
        viewBox="0 0 12 10"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
        className="h-3 w-3"
      >
        <polyline points="1,5 4.5,8.5 11,1" />
      </svg>
    </button>
  );
}

export default function CountScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { workDate, day } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();

  const [products, setProducts] = useState<Product[]>([]);
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [displayStock, setDisplayStock] = useState<Record<number, number>>({});
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
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
      const prepared = p.results.filter(
        (prod) => (dsMap[prod.id] ?? 0) > 0 || countedIds.has(prod.id)
      );
      setProducts(prepared);

      const savedSet = new Set(c.stock_counts.map((s) => s.product));
      setSavedIds(savedSet);

      const seed: Record<number, Row> = {};
      for (const prod of prepared) {
        const existing = c.stock_counts.find((s) => s.product === prod.id);
        seed[prod.id] = {
          remains: existing
            ? existing.remains_pieces
            : !prod.requires_preparation
            ? (dsMap[prod.id] ?? 0)
            : 0,
          wastage: existing ? existing.wastage_pieces : 0,
        };
      }
      setRows(seed);
    })();
  }, [outlet, opDate]);

  function setField(pid: number, key: keyof Row, val: number) {
    setRows((r) => {
      const cur = r[pid] ?? { remains: 0, wastage: 0 };
      const available = displayStock[pid] ?? 0;
      const other = key === "remains" ? cur.wastage : cur.remains;
      const clamped = Math.min(Math.max(0, val), Math.max(0, available - other));
      return { ...r, [pid]: { ...cur, [key]: clamped } };
    });
    setCheckedIds((prev) => { const n = new Set(prev); n.add(pid); return n; });
  }

  function toggleChecked(pid: number) {
    setCheckedIds((prev) => {
      const n = new Set(prev);
      if (n.has(pid)) n.delete(pid); else n.add(pid);
      return n;
    });
  }

  const isDone = (p: Product) => savedIds.has(p.id);

  async function save() {
    if (!closing) return;
    setBusy(true);
    const items = products.map((p) => ({
      product: p.id,
      remains_pieces: rows[p.id]?.remains ?? 0,
      wastage_pieces: rows[p.id]?.wastage ?? 0,
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

  const totalWalkin = products.reduce((sum, p) => {
    const available = displayStock[p.id] ?? 0;
    const r = rows[p.id] ?? { remains: 0, wastage: 0 };
    return sum + Math.max(0, available - r.remains - r.wastage);
  }, 0);

  const checkedCount = products.filter((p) => checkedIds.has(p.id)).length;

  if (day === null) {
    return (
      <div className="flex flex-col gap-3 pt-4">
        <h1 className="font-display text-xl font-bold">Count remains & wastage</h1>
        <p className="font-mono text-xs text-ink-soft">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Count remains & wastage</h1>
        <p className="text-xs text-ink-soft">Enter wastage and remaining pieces for each item</p>
      </div>

      <div className="flex gap-2">
        <div className="ticket-chip flex-1 text-center">
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Products</span>
          <span className="font-mono text-lg font-bold text-ink">{products.length}</span>
        </div>
        <div className="ticket-chip flex-1 text-center">
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Walk-in</span>
          <span className="font-mono text-lg font-bold text-leaf-deep">{totalWalkin}</span>
        </div>
        <div className="ticket-chip flex-1 text-center">
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Reviewed</span>
          <span className={`font-mono text-lg font-bold ${
            checkedCount === products.length ? "text-leaf-deep" : "text-gold-deep"
          }`}>
            {checkedCount}/{products.length}
          </span>
        </div>
      </div>

      <ProductListFilter
        products={products}
        isDone={isDone}
        doneLabel={(d, t) => `${d}/${t} saved`}
        showTypeFilter
        rawItems
        grouped
        renderRow={(p) => {
          const r = rows[p.id] ?? { remains: 0, wastage: 0 };
          const available = displayStock[p.id] ?? 0;
          const walkin = available - r.remains - r.wastage;
          const flagged = walkin < 0;
          const checked = checkedIds.has(p.id);

          return (
            <div className={`ticket overflow-hidden !p-0 ${flagged ? "border-chili/60" : ""}`}>
              <div className={`flex items-center justify-between px-3 py-2.5 ${flagged ? "bg-chili/5" : "bg-[#f5f0e8]"}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <ReviewToggle checked={checked} onToggle={() => toggleChecked(p.id)} />
                  <span className="font-display text-sm font-bold text-ink leading-tight truncate">
                    {p.name}
                  </span>
                </div>
                <span className="ml-2 shrink-0 rounded-full bg-paper px-2.5 py-0.5 font-mono text-[11px] text-ink-soft border border-[#d8cdb0]">
                  Avail&nbsp;<span className="font-bold text-ink">{available}</span>
                </span>
              </div>

              <div className="flex items-stretch gap-0 px-3 py-3">
                <div className="flex flex-1 flex-col gap-2.5">
                  <Stepper
                    label="Remains"
                    value={r.remains}
                    onChange={(v) => setField(p.id, "remains", v)}
                    max={Math.max(0, available - r.wastage)}
                  />
                  <Stepper
                    label="Wastage"
                    value={r.wastage}
                    onChange={(v) => setField(p.id, "wastage", v)}
                    max={Math.max(0, available - r.remains)}
                  />
                </div>

                <div className="ml-3 flex w-20 shrink-0 flex-col items-center justify-center border-l border-dashed border-[#d8cdb0] pl-3">
                  <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">
                    Walk-in
                  </span>
                  <span className={`font-mono text-3xl font-bold leading-tight ${flagged ? "text-chili" : "text-leaf-deep"}`}>
                    {flagged ? "!" : walkin}
                  </span>
                  {flagged ? (
                    <span className="mt-0.5 text-center font-mono text-[9px] text-chili">
                      over by {Math.abs(walkin)}
                    </span>
                  ) : (
                    <span className="mt-0.5 font-mono text-[9px] text-ink-soft/50">sold</span>
                  )}
                </div>
              </div>
            </div>
          );
        }}
      />

      <button className="btn btn-primary w-full" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save & back to checklist"}
      </button>
    </div>
  );
}
