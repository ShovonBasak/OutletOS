"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import { ProductListFilter } from "@/components/ProductListFilter";
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
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [busy, setBusy] = useState(false);

  const closingRef = useRef<DailyClosing | null>(null);
  const channelRef = useRef<SalesChannel | null>(null);
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

      const fp =
        ch.results.find((x) => x.is_active && x.name.toLowerCase().includes("foodpanda")) ?? null;
      setChannel(fp);
      channelRef.current = fp;

      const productMap: Record<number, Product> = {};
      p.results.forEach((prod) => { productMap[prod.id] = prod; });

      if (fp) {
        const fpLines = c.sales_lines.filter(
          (l) => l.source === "STAFF_ENTRY" && l.channel === fp.id
        );
        const seed: Record<number, number> = {};

        if (c.status !== "DRAFT") {
          setProducts(
            fpLines.map((l) => productMap[l.product]).filter(Boolean) as Product[]
          );
          fpLines.forEach((l) => { seed[l.product] = l.quantity_sold; });
        } else {
          setProducts(p.results.filter((prod) => (dsMap[prod.id] ?? 0) > 0));
          for (const l of fpLines) {
            if ((dsMap[l.product] ?? 0) > 0) {
              seed[l.product] = l.quantity_sold;
            } else {
              await api(`/daily-closings/${c.id}/online-sell/`, {
                method: "POST",
                body: JSON.stringify({
                  items: [{ product: l.product, channel: fp.id, quantity_sold: 0 }],
                }),
              });
            }
          }
        }
        setQty(seed);
      }
    })();
  }, [outlet, opDate]);

  async function persist(currentQty: Record<number, number>) {
    const c = closingRef.current;
    const ch = channelRef.current;
    if (!c || !ch || c.status !== "DRAFT") return;
    setSaveStatus("saving");
    try {
      const items = Object.entries(currentQty).map(([pid, v]) => ({
        product: Number(pid),
        channel: ch.id,
        quantity_sold: v,
      }));
      await api(`/daily-closings/${c.id}/online-sell/`, {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("idle");
    }
  }

  function scheduleSave(nextQty: Record<number, number>) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => persist(nextQty), 600);
  }

  function adjust(pid: number, delta: number) {
    setQty((prev) => {
      const max = maxQty[pid] ?? 0;
      const next = { ...prev, [pid]: Math.min(max, Math.max(0, (prev[pid] ?? 0) + delta)) };
      scheduleSave(next);
      return next;
    });
  }

  function setAbsolute(pid: number, val: number) {
    setQty((prev) => {
      const max = maxQty[pid] ?? 0;
      const next = { ...prev, [pid]: Math.min(max, Math.max(0, val)) };
      scheduleSave(next);
      return next;
    });
  }

  async function finish() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setBusy(true);
    await persist(qty);
    setBusy(false);
    router.push("/staff/closing");
  }

  const totalOrders = Object.values(qty).reduce((s, v) => s + v, 0);
  const isReadOnly = closing ? closing.status !== "DRAFT" : false;

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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-xl font-bold">Online sell</h1>
          <p className="text-xs text-ink-soft">
            {isReadOnly ? `View only · ${closing?.status}` : "Foodpanda · enter qty sold per item"}
          </p>
        </div>
        <span
          className={`font-mono text-[10px] transition-opacity ${
            saveStatus === "saving"
              ? "text-ink-soft"
              : saveStatus === "saved"
              ? "text-leaf-deep"
              : "opacity-0"
          }`}
        >
          {saveStatus === "saving" ? "Saving…" : "Saved ✓"}
        </span>
      </div>

      <div className="flex items-center justify-between rounded bg-paper-dim px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">
          Total orders today
        </span>
        <span className="num font-semibold">{totalOrders}</span>
      </div>

      <ProductListFilter
        products={products}
        isDone={(p) => (qty[p.id] ?? 0) > 0}
        doneLabel={(d, t) => `${d}/${t} with orders`}
        renderRow={(p) => (
          <ProductRow
            key={p.id}
            name={p.name}
            count={qty[p.id] ?? 0}
            max={maxQty[p.id] ?? 0}
            onAdjust={(d) => adjust(p.id, d)}
            onSet={(v) => setAbsolute(p.id, v)}
            readOnly={isReadOnly}
          />
        )}
      />

      {!isReadOnly && (
        <button className="btn btn-primary" disabled={busy} onClick={finish}>
          {busy ? "Saving…" : "Done — back to checklist"}
        </button>
      )}
    </div>
  );
}

function ProductRow({
  name,
  count,
  max,
  onAdjust,
  onSet,
  readOnly,
}: {
  name: string;
  count: number;
  max: number;
  onAdjust: (delta: number) => void;
  onSet: (v: number) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex flex-col min-w-0">
        <span className={`font-mono text-sm ${count > 0 ? "font-semibold text-ink" : "text-ink-soft"}`}>
          {name}
        </span>
        {max > 0 && !readOnly && (
          <span className="font-mono text-[10px] text-ink-soft/60">{max} prepared</span>
        )}
      </div>

      {readOnly ? (
        <span className={`num min-w-[1.5rem] text-center text-sm ${count > 0 ? "font-bold" : "text-ink-soft/30"}`}>
          {count}
        </span>
      ) : (
        <div className="flex items-center gap-1">
          <button
            className="flex h-9 w-9 items-center justify-center rounded border border-[#d8cdb0] bg-paper font-mono text-base text-ink active:bg-paper-dim disabled:opacity-30"
            onClick={() => onAdjust(-1)}
            disabled={count <= 0}
          >
            −
          </button>
          <input
            className="field-input h-9 !w-14 !px-0 text-center font-mono text-sm font-semibold"
            inputMode="numeric"
            value={count}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n) && n >= 0) onSet(n);
              else if (e.target.value === "") onSet(0);
            }}
          />
          <button
            className="flex h-9 w-9 items-center justify-center rounded border border-[#d8cdb0] bg-paper font-mono text-base text-ink active:bg-paper-dim disabled:opacity-30"
            onClick={() => onAdjust(1)}
            disabled={count >= max}
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
