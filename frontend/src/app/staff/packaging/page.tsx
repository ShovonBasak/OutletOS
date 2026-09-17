"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { timeOf } from "@/lib/format";
import type { PackagingLevel } from "@/lib/types";

export default function PackagingPage() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const [items, setItems] = useState<PackagingLevel[]>([]);
  const [recountFor, setRecountFor] = useState<number | null>(null);
  const [recountValue, setRecountValue] = useState("");
  const [pendingBundle, setPendingBundle] = useState<number | null>(null);
  const [bundleSizeFor, setBundleSizeFor] = useState<number | null>(null);
  const [bundleSizeValue, setBundleSizeValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const data = await api<PackagingLevel[]>(
      `/periodic-stock-checks/levels/?outlet=${outlet}`
    );
    setItems(data);
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

  async function saveBundleSize(ingredientId: number) {
    if (bundleSizeValue === "" || Number(bundleSizeValue) <= 0) return;
    setBusy(true);
    try {
      await api("/periodic-stock-checks/set-bundle-size/", {
        method: "POST",
        body: JSON.stringify({ ingredient: ingredientId, bundle_size: bundleSizeValue }),
      });
      setBundleSizeFor(null);
      setBundleSizeValue("");
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
        <p className="text-xs text-ink-soft">Current quantities — recount or deduct as needed</p>
      </div>

      <div className="flex flex-col gap-3">
        {items.map((item) => {
          const qty = Number(item.current_qty);
          const isDerived = item.source === "stock_in_derived";
          const isRecount = recountFor === item.ingredient;
          const isPending = pendingBundle === item.ingredient;
          const isBundleSizeEdit = bundleSizeFor === item.ingredient;

          return (
            <div key={item.ingredient} className="ticket flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <span className="font-display text-sm font-bold">{item.ingredient_name}</span>
                <div className="text-right shrink-0">
                  <p className="qty text-ink">
                    {qty} {item.base_unit}
                  </p>
                  {isDerived ? (
                    <p className="font-mono text-[9px] text-gold-deep uppercase tracking-wide">
                      from stock-in · unconfirmed
                    </p>
                  ) : item.last_checked_at ? (
                    <p className="font-mono text-[9px] text-ink-soft/60">
                      counted {timeOf(item.last_checked_at)}
                    </p>
                  ) : null}
                </div>
              </div>

              {/* Bundle size — configurable, this is what "− 1 bundle" subtracts */}
              {!isBundleSizeEdit && (
                <button
                  className="self-start font-mono text-[10px] text-ink-soft underline decoration-dotted"
                  onClick={() => {
                    setBundleSizeFor(item.ingredient);
                    setBundleSizeValue(item.bundle_size ?? "");
                  }}
                >
                  {item.bundle_size
                    ? `Bundle size: ${item.bundle_size} ${item.base_unit} · edit`
                    : "Bundle size not set · tap to configure"}
                </button>
              )}

              {isDerived && (
                <p className="font-mono text-[10px] text-gold-deep bg-gold/10 rounded px-2 py-1">
                  Quantity loaded from approved stock-in records. Tap Recount to confirm the actual amount on hand.
                </p>
              )}

              {isBundleSizeEdit ? (
                <div className="rounded bg-paper-dim px-2 py-2">
                  <p className="mb-1.5 font-mono text-[10px] text-ink-soft">
                    How many {item.base_unit} in one bundle/pack of {item.ingredient_name}?
                  </p>
                  <div className="flex gap-2">
                    <input
                      className="field-input flex-1"
                      inputMode="decimal"
                      placeholder={`${item.base_unit} per bundle`}
                      value={bundleSizeValue}
                      onChange={(e) => setBundleSizeValue(e.target.value)}
                      autoFocus
                    />
                    <button className="btn btn-ghost" onClick={() => setBundleSizeFor(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => saveBundleSize(item.ingredient)}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : isPending ? (
                <div className="rounded bg-gold/10 px-2 py-2">
                  <p className="font-mono text-[11px] text-gold-deep">
                    Subtract one full bundle ({item.bundle_size ?? "?"} {item.base_unit})?
                  </p>
                  <div className="mt-1.5 flex gap-2">
                    <button className="btn btn-ghost flex-1" onClick={() => setPendingBundle(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary flex-1"
                      disabled={busy}
                      onClick={() => confirmBundle(item.ingredient)}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              ) : isRecount ? (
                <div className="flex gap-2">
                  <input
                    className="field-input flex-1"
                    inputMode="decimal"
                    placeholder={`Counted ${item.base_unit}`}
                    value={recountValue}
                    onChange={(e) => setRecountValue(e.target.value)}
                    autoFocus
                  />
                  <button className="btn btn-ghost" onClick={() => setRecountFor(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => saveRecount(item.ingredient)}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    className="btn btn-ghost flex-1"
                    onClick={() => {
                      setRecountFor(item.ingredient);
                      setRecountValue(qty > 0 ? String(qty) : "");
                    }}
                  >
                    Recount
                  </button>
                  {item.bundle_size && (
                    <button
                      className="btn btn-primary flex-1"
                      onClick={() => setPendingBundle(item.ingredient)}
                    >
                      − 1 bundle
                    </button>
                  )}
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
