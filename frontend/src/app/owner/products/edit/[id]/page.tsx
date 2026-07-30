"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { bdt, shortDate, today } from "@/lib/format";
import type { Product, ProductPrice } from "@/lib/types";

interface EditState {
  price: string;
  effective_from: string;
  effective_to: string;
  note: string;
}

export default function EditProductPricePage() {
  const { id } = useParams<{ id: string }>();

  const [product, setProduct] = useState<Product | null>(null);
  const [history, setHistory] = useState<ProductPrice[]>([]);

  // "Set price" form — forward-scheduling a new current price
  const [newPrice, setNewPrice] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Inline edit state — keyed by price row id
  const [editing, setEditing] = useState<Record<number, EditState>>({});
  const [editSaving, setEditSaving] = useState<number | null>(null);
  const [editMsg, setEditMsg] = useState<Record<number, string>>({});

  // Add historical record form
  const [showAddHist, setShowAddHist] = useState(false);
  const [histPrice, setHistPrice] = useState("");
  const [histFrom, setHistFrom] = useState("");
  const [histTo, setHistTo] = useState("");
  const [histNote, setHistNote] = useState("");
  const [histSaving, setHistSaving] = useState(false);
  const [histMsg, setHistMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    const [p, h] = await Promise.all([
      api<Product>(`/products/${id}/`),
      api<ProductPrice[]>(`/products/${id}/price-history/`),
    ]);
    setProduct(p);
    setHistory(h);
    if (p.active_price) setNewPrice(p.active_price.price);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Set price (forward) ─────────────────────────────────────────────────
  async function savePrice() {
    if (!newPrice) { setMsg({ text: "Enter a price.", ok: false }); return; }
    setSaving(true);
    setMsg(null);
    try {
      await api(`/products/${id}/set-price/`, {
        method: "POST",
        body: JSON.stringify({ price: newPrice, effective_from: effectiveFrom, note }),
      });
      setMsg({ text: "Price updated ✓", ok: true });
      setNote("");
      await load();
    } catch {
      setMsg({ text: "Could not update price.", ok: false });
    } finally {
      setSaving(false);
    }
  }

  // ── Inline edit ──────────────────────────────────────────────────────────
  function startEdit(row: ProductPrice) {
    setEditing((prev) => ({
      ...prev,
      [row.id]: {
        price: row.price,
        effective_from: row.effective_from,
        effective_to: row.effective_to ?? "",
        note: row.note,
      },
    }));
    setEditMsg((prev) => { const n = { ...prev }; delete n[row.id]; return n; });
  }

  function cancelEdit(id: number) {
    setEditing((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  function patchEdit(rowId: number, field: keyof EditState, value: string) {
    setEditing((prev) => ({ ...prev, [rowId]: { ...prev[rowId], [field]: value } }));
  }

  async function saveEdit(rowId: number) {
    const e = editing[rowId];
    if (!e) return;
    setEditSaving(rowId);
    try {
      await api(`/product-prices/${rowId}/`, {
        method: "PATCH",
        body: JSON.stringify({
          price: e.price,
          effective_from: e.effective_from,
          effective_to: e.effective_to || null,
          note: e.note,
        }),
      });
      cancelEdit(rowId);
      await load();
    } catch {
      setEditMsg((prev) => ({ ...prev, [rowId]: "Save failed." }));
    } finally {
      setEditSaving(null);
    }
  }

  // ── Add historical record ────────────────────────────────────────────────
  async function addHistorical() {
    if (!histPrice || !histFrom || !histTo) {
      setHistMsg({ text: "Price, effective from, and effective to are all required for a historical record.", ok: false });
      return;
    }
    setHistSaving(true);
    setHistMsg(null);
    try {
      await api("/product-prices/", {
        method: "POST",
        body: JSON.stringify({
          product: Number(id),
          price: histPrice,
          effective_from: histFrom,
          effective_to: histTo,
          note: histNote,
        }),
      });
      setHistMsg({ text: "Historical record added ✓", ok: true });
      setHistPrice(""); setHistFrom(""); setHistTo(""); setHistNote("");
      setShowAddHist(false);
      await load();
    } catch {
      setHistMsg({ text: "Could not add record.", ok: false });
    } finally {
      setHistSaving(false);
    }
  }

  if (!product) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  return (
    <div className="flex flex-col gap-5">
      <Link href="/owner/products" className="self-start font-mono text-[11px] text-ink-soft">
        ‹ Back to Products &amp; packs
      </Link>

      <div>
        <h1 className="font-display text-xl font-bold">{product.name}</h1>
        <p className="text-xs text-ink-soft capitalize">
          {product.category} · {product.product_type.toLowerCase()}
        </p>
      </div>

      {/* Set price forward */}
      <div className="ticket flex flex-col gap-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">
          Set price (walk-in)
        </p>
        <div className="formgrid">
          <label className="field">
            <span className="field-label">Price (৳)</span>
            <input
              className="field-input"
              inputMode="decimal"
              placeholder="e.g. 95"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Effective from</span>
            <input
              className="field-input"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </label>
          <label className="field sm:col-span-2">
            <span className="field-label">Note (optional)</span>
            <input
              className="field-input"
              placeholder="e.g. cost increase from supplier"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-ink-soft">
          Closes the current active price on <span className="font-mono">{effectiveFrom}</span> − 1 day
          and opens a new one. To edit an existing row, use the history table below.
        </p>
        {msg && (
          <p className={`font-mono text-[11px] ${msg.ok ? "text-leaf-deep" : "text-chili-deep"}`}>
            {msg.text}
          </p>
        )}
        <button className="btn btn-primary w-36 self-start" disabled={saving} onClick={savePrice}>
          {saving ? "Saving…" : "Set price"}
        </button>
      </div>

      {/* Price history */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="sec">Price history</h2>
          <button
            className="font-mono text-[11px] text-gold-deep underline"
            onClick={() => { setShowAddHist((v) => !v); setHistMsg(null); }}
          >
            {showAddHist ? "Cancel" : "+ Add historical record"}
          </button>
        </div>

        {/* Add historical record form */}
        {showAddHist && (
          <div className="rounded border border-gold/40 bg-gold/5 p-4 flex flex-col gap-3">
            <p className="font-mono text-[10px] uppercase tracking-wide text-gold-deep">
              Historical price entry
            </p>
            <p className="text-xs text-ink-soft">
              Use this to insert a past price range. Both dates are required. The record is added
              as-is — no existing rows are auto-closed.
            </p>
            <div className="formgrid">
              <label className="field">
                <span className="field-label">Price (৳)</span>
                <input className="field-input" inputMode="decimal" value={histPrice} onChange={(e) => setHistPrice(e.target.value)} />
              </label>
              <label className="field" />
              <label className="field">
                <span className="field-label">Effective from</span>
                <input className="field-input" type="date" value={histFrom} onChange={(e) => setHistFrom(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Effective to</span>
                <input className="field-input" type="date" value={histTo} onChange={(e) => setHistTo(e.target.value)} />
              </label>
              <label className="field sm:col-span-2">
                <span className="field-label">Note (optional)</span>
                <input className="field-input" value={histNote} onChange={(e) => setHistNote(e.target.value)} />
              </label>
            </div>
            {histMsg && (
              <p className={`font-mono text-[11px] ${histMsg.ok ? "text-leaf-deep" : "text-chili-deep"}`}>
                {histMsg.text}
              </p>
            )}
            <button className="btn btn-primary w-44 self-start" disabled={histSaving} onClick={addHistorical}>
              {histSaving ? "Saving…" : "Add historical record"}
            </button>
          </div>
        )}

        {/* History table with inline edit */}
        {history.length > 0 ? (
          <div className="flex flex-col gap-2">
            {history.map((row) => {
              const e = editing[row.id];
              return (
                <div
                  key={row.id}
                  className={`rounded border px-4 py-3 ${
                    row.is_active ? "border-leaf/40 bg-leaf/5" : "border-[#d8cdb0] bg-paper"
                  }`}
                >
                  {e ? (
                    /* Edit mode */
                    <div className="flex flex-col gap-3">
                      <div className="formgrid">
                        <label className="field">
                          <span className="field-label">Price (৳)</span>
                          <input
                            className="field-input !py-1"
                            inputMode="decimal"
                            value={e.price}
                            onChange={(ev) => patchEdit(row.id, "price", ev.target.value)}
                          />
                        </label>
                        <label className="field" />
                        <label className="field">
                          <span className="field-label">Effective from</span>
                          <input
                            className="field-input !py-1"
                            type="date"
                            value={e.effective_from}
                            onChange={(ev) => patchEdit(row.id, "effective_from", ev.target.value)}
                          />
                        </label>
                        <label className="field">
                          <span className="field-label">Effective to {row.is_active && <span className="text-ink-soft">(blank = current)</span>}</span>
                          <input
                            className="field-input !py-1"
                            type="date"
                            value={e.effective_to}
                            onChange={(ev) => patchEdit(row.id, "effective_to", ev.target.value)}
                          />
                        </label>
                        <label className="field sm:col-span-2">
                          <span className="field-label">Note</span>
                          <input
                            className="field-input !py-1"
                            value={e.note}
                            onChange={(ev) => patchEdit(row.id, "note", ev.target.value)}
                          />
                        </label>
                      </div>
                      {editMsg[row.id] && (
                        <p className="font-mono text-[11px] text-chili-deep">{editMsg[row.id]}</p>
                      )}
                      <div className="flex gap-2">
                        <button
                          className="btn btn-primary w-24 !py-1 text-[11px]"
                          disabled={editSaving === row.id}
                          onClick={() => saveEdit(row.id)}
                        >
                          {editSaving === row.id ? "Saving…" : "Save"}
                        </button>
                        <button
                          className="btn btn-ghost w-24 !py-1 text-[11px]"
                          onClick={() => cancelEdit(row.id)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Read mode */
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-baseline gap-3">
                          <span className="font-mono text-base font-bold">{bdt(row.price)}</span>
                          {row.is_active && (
                            <span className="stamp stamp-approved rotate-0 text-[9px]">Current</span>
                          )}
                        </div>
                        <span className="font-mono text-[11px] text-ink-soft">
                          {shortDate(row.effective_from)}
                          {row.effective_to ? ` → ${shortDate(row.effective_to)}` : " → ongoing"}
                        </span>
                        {row.note && (
                          <span className="font-mono text-[10px] text-ink-soft">{row.note}</span>
                        )}
                      </div>
                      <button
                        className="shrink-0 font-mono text-[11px] text-gold-deep underline"
                        onClick={() => startEdit(row)}
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="font-mono text-xs text-ink-soft">No price history yet.</p>
        )}
      </div>
    </div>
  );
}
