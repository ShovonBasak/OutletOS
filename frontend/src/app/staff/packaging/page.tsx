"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Ingredient, Paginated, PeriodicStockCheck } from "@/lib/types";

export default function PackagingPage() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const [items, setItems] = useState<Ingredient[]>([]);
  const [latest, setLatest] = useState<Record<number, PeriodicStockCheck>>({});
  const [recountFor, setRecountFor] = useState<number | null>(null);
  const [recountValue, setRecountValue] = useState("");
  const [pendingBundle, setPendingBundle] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [ing, checks] = await Promise.all([
      api<Paginated<Ingredient>>("/ingredients/?tracking_mode=PERIODIC_COUNT&active=true"),
      api<Paginated<PeriodicStockCheck>>(
        `/periodic-stock-checks/?outlet=${outlet}&latest_per_ingredient=true`
      ),
    ]);
    setItems(ing.results);
    const map: Record<number, PeriodicStockCheck> = {};
    checks.results.forEach((c) => {
      if (!map[c.ingredient]) map[c.ingredient] = c;
    });
    setLatest(map);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet]);

  async function saveRecount(ingredientId: number) {
    if (recountValue === "") return;
    setBusy(true);
    try {
      await api("/periodic-stock-checks/", {
        method: "POST",
        body: JSON.stringify({ outlet, ingredient: ingredientId, counted_qty: recountValue }),
      });
      setRecountFor(null);
      setRecountValue("");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function confirmBundle(ingredientId: number) {
    setBusy(true);
    try {
      await api("/periodic-stock-checks/bundle-finished/", {
        method: "POST",
        body: JSON.stringify({ outlet, ingredient: ingredientId }),
      });
      setPendingBundle(null);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/staff" className="self-start font-mono text-[11px] text-ink">
        ‹ Back
      </Link>
      <div>
        <h1 className="font-display text-xl font-bold">Packaging &amp; supplies</h1>
        <p className="text-xs text-ink-soft">Report what&apos;s left — not what you used</p>
      </div>

      <div className="flex flex-col gap-3">
        {items.map((ing) => {
          const last = latest[ing.id];
          const isRecount = recountFor === ing.id;
          const isPending = pendingBundle === ing.id;
          return (
            <div key={ing.id} className="ticket flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-bold">{ing.name}</span>
                <span className="qty text-ink-soft">
                  {last ? `${last.counted_qty} ${ing.base_unit} left` : "no count yet"}
                </span>
              </div>

              {isPending ? (
                <div className="rounded bg-gold/10 px-2 py-2">
                  <p className="font-mono text-[11px] text-gold-deep">
                    Subtract one full pack ({ing.active_pack?.pieces_per_pack ?? "?"} {ing.base_unit})?
                  </p>
                  <div className="mt-1.5 flex gap-2">
                    <button className="btn btn-ghost flex-1" onClick={() => setPendingBundle(null)}>
                      Cancel
                    </button>
                    <button className="btn btn-primary flex-1" disabled={busy} onClick={() => confirmBundle(ing.id)}>
                      Confirm
                    </button>
                  </div>
                </div>
              ) : isRecount ? (
                <div className="flex gap-2">
                  <input
                    className="field-input flex-1"
                    inputMode="decimal"
                    placeholder={`Counted ${ing.base_unit}`}
                    value={recountValue}
                    onChange={(e) => setRecountValue(e.target.value)}
                    autoFocus
                  />
                  <button className="btn btn-ghost" onClick={() => setRecountFor(null)}>
                    Cancel
                  </button>
                  <button className="btn btn-primary" disabled={busy} onClick={() => saveRecount(ing.id)}>
                    Save
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    className="btn btn-ghost flex-1"
                    onClick={() => {
                      setRecountFor(ing.id);
                      setRecountValue(last ? String(last.counted_qty) : "");
                    }}
                  >
                    Recount
                  </button>
                  <button className="btn btn-primary flex-1" onClick={() => setPendingBundle(ing.id)}>
                    − 1 bundle
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {items.length === 0 && (
          <p className="font-mono text-xs text-ink-soft">No packaging items configured.</p>
        )}
      </div>
    </div>
  );
}
