"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import { ProductListFilter } from "@/components/ProductListFilter";
import { bdt } from "@/lib/format";
import type { DailyClosing, DisplayStock, Paginated, Product, SalesChannel } from "@/lib/types";

type UnresolvedItem = { external_name: string; order_qty: number };

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

  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [unresolved, setUnresolved] = useState<UnresolvedItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const closingRef = useRef<DailyClosing | null>(null);
  const channelRef = useRef<SalesChannel | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadData(existingChannel?: SalesChannel | null) {
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
      existingChannel ??
      ch.results.find((x) => x.is_active && x.name.toLowerCase().includes("foodpanda")) ??
      null;
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
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const c = closingRef.current;
    const ch = channelRef.current;
    if (!file || !c || !ch) return;

    setUploadStatus("uploading");
    setUnresolved([]);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("channel", String(ch.id));

      const result = await api<{
        mapped: { product_id: number; product_name: string; quantity: number }[];
        unresolved: UnresolvedItem[];
        closing: DailyClosing;
      }>(`/daily-closings/${c.id}/import-online-sells/`, { method: "POST", body: form });

      // Refresh the page data so quantities reflect the upload
      await loadData(ch);
      setUnresolved(result.unresolved);
      setUploadStatus("done");
    } catch {
      setUploadStatus("error");
    }
    // Reset file input so the same file can be re-uploaded after adding mappings
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function finish() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setBusy(true);
    await persist(qty);
    setBusy(false);
    router.push("/staff/closing");
  }

  const totalOrders = Object.values(qty).reduce((s, v) => s + v, 0);
  const totalRevenue = products.reduce(
    (s, p) => s + (qty[p.id] ?? 0) * (Number(p.selling_price) || 0),
    0
  );
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

      {/* Excel upload */}
      {!isReadOnly && (
        <div className="rounded border border-dashed border-[#d8cdb0] bg-paper-dim px-3 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft mb-2">
            Upload Foodpanda report
          </p>
          <label
            className={`btn btn-sm inline-flex cursor-pointer items-center gap-1.5 font-mono text-xs ${
              uploadStatus === "uploading" ? "opacity-50 pointer-events-none" : ""
            }`}
          >
            {uploadStatus === "uploading"
              ? "Uploading…"
              : uploadStatus === "done"
              ? "Re-upload"
              : "Choose Excel file (.xlsx)"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="sr-only"
              onChange={handleFileUpload}
              disabled={uploadStatus === "uploading"}
            />
          </label>
          {uploadStatus === "error" && (
            <p className="mt-1.5 font-mono text-[10px] text-chili">
              Upload failed — check the file format and try again.
            </p>
          )}
          {uploadStatus === "done" && unresolved.length === 0 && (
            <p className="mt-1.5 font-mono text-[10px] text-leaf-deep">
              All items imported successfully.
            </p>
          )}
        </div>
      )}

      {/* Unresolved items */}
      {unresolved.length > 0 && (
        <div className="rounded border border-chili/30 bg-chili/5 px-3 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-chili mb-2">
            {unresolved.length} item name{unresolved.length > 1 ? "s" : ""} not mapped — ask owner to add mapping
          </p>
          <div className="flex flex-col gap-1">
            {unresolved.map((u) => (
              <div key={u.external_name} className="flex items-center justify-between">
                <span className="font-mono text-xs text-ink">{u.external_name}</span>
                <span className="font-mono text-[10px] text-ink-soft">{u.order_qty} ordered</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <div className="ticket-chip flex-1 text-center">
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Orders</span>
          <span className="font-mono text-lg font-bold text-ink">{totalOrders}</span>
        </div>
        <div className="ticket-chip flex-1 text-center">
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Revenue</span>
          <span className="font-mono text-lg font-bold text-leaf-deep">{bdt(totalRevenue)}</span>
        </div>
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
            price={Number(p.selling_price) || 0}
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
  price,
  max,
  onAdjust,
  onSet,
  readOnly,
}: {
  name: string;
  count: number;
  price: number;
  max: number;
  onAdjust: (delta: number) => void;
  onSet: (v: number) => void;
  readOnly?: boolean;
}) {
  const lineValue = count > 0 && price > 0 ? bdt(count * price) : null;

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex flex-col min-w-0">
        <span className={`font-mono text-sm ${count > 0 ? "font-semibold text-ink" : "text-ink-soft"}`}>
          {name}
        </span>
        {!readOnly && max > 0 && (
          <span className="font-mono text-[10px] text-ink-soft/60">{max} prepared</span>
        )}
        {lineValue && (
          <span className="font-mono text-[11px] text-leaf-deep">{lineValue}</span>
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
