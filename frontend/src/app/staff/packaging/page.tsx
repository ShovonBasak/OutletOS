"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { shortDate, timeOf } from "@/lib/format";
import type { PackagingLevel } from "@/lib/types";

/** Quantity field — can only move down from `max` (the current confirmed
 * level); increases only ever happen via Stock In. Mirrors the Stepper
 * pattern from staff/closing/count/page.tsx: steppable via ±, always
 * directly editable too. `integer` rounds typed values (used for whole
 * bundles — staff count bundles, never fractions of one). */
function QtyField({
  value,
  max,
  step,
  unit,
  integer,
  onChange,
}: {
  value: number;
  max: number;
  step: number;
  unit: string;
  integer?: boolean;
  onChange: (v: number) => void;
}) {
  const atZero = value <= 0;
  const clamp = (n: number) => {
    const v = Math.min(max, Math.max(0, n));
    return integer ? Math.round(v) : v;
  };

  return (
    <div className="flex items-center gap-1.5">
      {step > 0 && (
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded border border-[#d8cdb0] bg-paper font-mono text-base text-ink active:bg-paper-dim disabled:opacity-40"
          onClick={() => onChange(clamp(value - step))}
          disabled={value <= 0}
        >
          −
        </button>
      )}
      <input
        className={`field-input h-9 !w-20 !px-0 text-center font-mono text-sm font-semibold ${
          atZero ? "!border-chili/50 !bg-chili/5" : ""
        }`}
        inputMode={integer ? "numeric" : "decimal"}
        value={value}
        onChange={(e) => {
          if (e.target.value === "") return onChange(0);
          const n = Number(e.target.value);
          if (!isNaN(n)) onChange(clamp(n));
        }}
      />
      {unit && <span className="font-mono text-[11px] text-ink-soft">{unit}</span>}
      {step > 0 && (
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded border border-[#d8cdb0] bg-paper font-mono text-base text-ink active:bg-paper-dim disabled:opacity-40"
          onClick={() => onChange(clamp(value + step))}
          disabled={value >= max}
        >
          +
        </button>
      )}
    </div>
  );
}

export default function PackagingPage() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const [items, setItems] = useState<PackagingLevel[]>([]);
  // Working (not-yet-saved) displayed value per ingredient — in whole bundles
  // for items with a bundle size, in base_unit for items without one. Only
  // present while that row has an unsaved change pending.
  const [pending, setPending] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const data = await api<PackagingLevel[]>(
      `/periodic-stock-checks/levels/?outlet=${outlet}`
    );
    data.sort((a, b) => a.ingredient_display_name.localeCompare(b.ingredient_display_name));
    setItems(data);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet]);

  function bundleStep(item: PackagingLevel) {
    return Number(item.bundle_size ?? 0);
  }

  // Staff count whole bundles, not pieces — so the on-screen number is
  // "bundles left" (floor: a part-bundle isn't a countable unit) whenever a
  // bundle size is configured. Items without one fall back to the raw
  // base-unit count (there's no higher unit to hide pieces behind).
  function originalDisplay(item: PackagingLevel) {
    const step = bundleStep(item);
    const qty = Number(item.current_qty);
    return step > 0 ? Math.floor(qty / step) : qty;
  }

  function workingDisplay(item: PackagingLevel) {
    return pending[item.ingredient] ?? originalDisplay(item);
  }

  function clearPending(ingredientId: number) {
    setPending((p) => {
      if (!(ingredientId in p)) return p;
      const next = { ...p };
      delete next[ingredientId];
      return next;
    });
  }

  async function saveAdjustment(item: PackagingLevel) {
    const original = originalDisplay(item);
    const working = workingDisplay(item);
    if (working === original) {
      clearPending(item.ingredient);
      return;
    }
    const step = bundleStep(item);

    setBusy(true);
    try {
      if (step > 0) {
        await api("/periodic-stock-checks/bundle-finished/", {
          method: "POST",
          body: JSON.stringify({ outlet, ingredient: item.ingredient, bundles: original - working }),
        });
      } else {
        await api("/periodic-stock-checks/", {
          method: "POST",
          body: JSON.stringify({ outlet, ingredient: item.ingredient, counted_qty: working }),
        });
      }
      clearPending(item.ingredient);
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
        <p className="text-xs text-ink-soft">Tap − to count down what&apos;s left, then save</p>
      </div>

      <div className="flex flex-col gap-3">
        {items.map((item) => {
          const original = originalDisplay(item);
          const working = workingDisplay(item);
          const hasPendingChange = working !== original;
          const isDerived = item.source === "stock_in_derived";
          const isOut = !hasPendingChange && working <= 0;
          const step = bundleStep(item);
          const hasBundle = step > 0;
          const diff = original - working;
          const unit = hasBundle ? (working === 1 ? "bundle" : "bundles") : item.base_unit;
          const diffUnit = hasBundle ? (diff === 1 ? "bundle" : "bundles") : item.base_unit;

          return (
            <div
              key={item.ingredient}
              className={`ticket flex flex-col gap-2 ${isOut ? "!border-chili/40 !bg-chili/5" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-sm font-bold">{item.ingredient_display_name}</span>
                {hasPendingChange ? (
                  <span className="font-mono text-[9px] text-chili uppercase tracking-wide">
                    was {original}
                  </span>
                ) : isDerived ? (
                  <span className="font-mono text-[9px] text-gold-deep uppercase tracking-wide">
                    unconfirmed
                  </span>
                ) : item.last_checked_at ? (
                  <span className="font-mono text-[9px] text-ink-soft/60">
                    {shortDate(item.last_checked_at)} · {timeOf(item.last_checked_at)}
                  </span>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-2">
                <QtyField
                  value={working}
                  max={original}
                  step={hasBundle ? 1 : 0}
                  unit={hasBundle ? "" : unit}
                  integer={hasBundle}
                  onChange={(v) => setPending((p) => ({ ...p, [item.ingredient]: v }))}
                />
                {hasBundle && (
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-[11px] font-semibold text-ink">
                      = {working * step} {item.base_unit}
                    </p>
                    <p className="font-mono text-[9px] text-ink-soft/60">
                      1 bundle = {item.bundle_size} {item.base_unit}
                    </p>
                  </div>
                )}
              </div>

              {hasPendingChange && (
                <div className="flex gap-2">
                  <button
                    className="btn btn-ghost flex-1"
                    onClick={() => clearPending(item.ingredient)}
                  >
                    Reset
                  </button>
                  <button
                    className="btn btn-primary flex-1"
                    disabled={busy}
                    onClick={() => saveAdjustment(item)}
                  >
                    Save −{diff} {diffUnit}
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
