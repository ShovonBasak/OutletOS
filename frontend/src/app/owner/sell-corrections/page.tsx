"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";

interface SellRow {
  product_id: number;
  name: string;
  category: string;
  quantity_sold: number;
  app_sold: number;
}

interface DailySellsResponse {
  date: string;
  rows: SellRow[];
}

interface CorrectionResult {
  product: string;
  old_qty: number;
  new_qty: number;
  delta: number;
}

interface StockRow {
  ingredient: string;
  quantity: number;
  unit: string;
  negative: boolean;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function SellCorrectionsPage() {
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<SellRow[]>([]);
  const [edits, setEdits] = useState<Record<number, string>>({});

  // Add-product panel
  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const addPanelRef = useRef<HTMLDivElement>(null);
  const addSearchRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [saveResult, setSaveResult] = useState<CorrectionResult[] | null>(null);
  const [rebuildStock, setRebuildStock] = useState<StockRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setEdits({});
    setSaveResult(null);
    setRebuildStock(null);
    setError(null);
    setAddOpen(false);
    setAddSearch("");
    try {
      const res = await api<DailySellsResponse>(
        `/reports/daily-sells/?outlet=1&date=${date}`
      );
      setRows(res.rows);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  // Close add panel on outside click
  useEffect(() => {
    if (!addOpen) return;
    function handleClick(e: MouseEvent) {
      if (addPanelRef.current && !addPanelRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [addOpen]);

  // Focus search when panel opens
  useEffect(() => {
    if (addOpen) setTimeout(() => addSearchRef.current?.focus(), 50);
  }, [addOpen]);

  // Rows shown in the main table: those with sales + those manually added
  const tableRows = useMemo(() => {
    const withSales = rows.filter((r) => r.quantity_sold > 0);
    const added = rows.filter(
      (r) => r.quantity_sold === 0 && edits[r.product_id] !== undefined
    );
    return [...withSales, ...added];
  }, [rows, edits]);

  // Products available to add (not sold and not already added)
  const addableRows = useMemo(() => {
    const term = addSearch.toLowerCase();
    return rows.filter(
      (r) =>
        r.quantity_sold === 0 &&
        edits[r.product_id] === undefined &&
        (!term || r.name.toLowerCase().includes(term) || r.category.toLowerCase().includes(term))
    );
  }, [rows, edits, addSearch]);

  // Group addable rows by category for display
  const addableGrouped = useMemo(() => {
    const map = new Map<string, SellRow[]>();
    for (const r of addableRows) {
      const cat = r.category || "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(r);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [addableRows]);

  function addProduct(row: SellRow) {
    setEdits((prev) => ({ ...prev, [row.product_id]: "1" }));
    setAddSearch("");
    // Keep panel open so user can add more
  }

  function removeAdded(productId: number) {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  }

  function handleEdit(productId: number, value: string) {
    setEdits((prev) => ({ ...prev, [productId]: value }));
    setSaveResult(null);
    setError(null);
  }

  const changedRows = useMemo(
    () =>
      rows.filter((r) => {
        const raw = edits[r.product_id];
        if (raw === undefined) return false;
        const n = parseInt(raw, 10);
        return !isNaN(n) && n !== r.quantity_sold;
      }),
    [rows, edits]
  );

  async function handleSave() {
    if (changedRows.length === 0) return;
    setSaving(true);
    setError(null);
    setSaveResult(null);
    try {
      const corrections = changedRows.map((r) => ({
        product_id: r.product_id,
        new_qty: parseInt(edits[r.product_id], 10),
      }));
      const res = await api<{ ok: boolean; applied: CorrectionResult[] }>(
        "/reports/correct-sells/",
        { method: "POST", body: JSON.stringify({ outlet: 1, date, corrections }) }
      );
      setSaveResult(res.applied);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleRebuild() {
    setRebuilding(true);
    setConfirmRebuild(false);
    setError(null);
    setRebuildStock(null);
    try {
      const res = await api<{ ok: boolean; stock: StockRow[] }>(
        "/reports/rebuild-rawstock/",
        { method: "POST", body: JSON.stringify({ outlet: 1 }) }
      );
      setRebuildStock(res.stock);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Rebuild failed");
    } finally {
      setRebuilding(false);
    }
  }

  function diffInfo(row: SellRow) {
    const raw = edits[row.product_id];
    if (raw === undefined) return null;
    const n = parseInt(raw, 10);
    if (isNaN(n)) return null;
    const d = n - row.quantity_sold;
    if (d === 0) return null;
    return { d, positive: d > 0 };
  }

  const isNewRow = (row: SellRow) => row.quantity_sold === 0 && edits[row.product_id] !== undefined;

  return (
    <div className="flex flex-col gap-6">

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-ink">Sell corrections</h1>
          <p className="text-xs text-ink-soft">
            Correct or add sells for a day. Stock updates by the exact difference.
          </p>
        </div>

        {/* Rebuild — top right */}
        <div className="flex flex-col items-end gap-1">
          {!confirmRebuild ? (
            <button
              className="rounded border border-chili/40 bg-transparent px-3 py-1.5 text-xs text-chili hover:bg-chili/5 disabled:opacity-50"
              onClick={() => setConfirmRebuild(true)}
              disabled={rebuilding}
            >
              {rebuilding ? "Rebuilding…" : "Rebuild all stock"}
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded border border-chili/40 bg-chili/5 px-3 py-1.5">
              <span className="text-xs text-chili">Recalculates from all history. Continue?</span>
              <button
                className="rounded bg-chili px-2.5 py-0.5 text-xs font-semibold text-paper"
                onClick={handleRebuild}
              >
                Yes, rebuild
              </button>
              <button
                className="text-xs text-ink-soft hover:text-ink"
                onClick={() => setConfirmRebuild(false)}
              >
                Cancel
              </button>
            </div>
          )}
          <p className="text-[10px] text-ink-soft">Use rarely — after bulk data fixes</p>
        </div>
      </div>

      {/* Date picker */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="date"
          className="field-input !py-1.5 !text-sm"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button
          className="btn btn-primary !py-1.5 !px-4 !text-xs"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded border border-chili/30 bg-chili/5 px-4 py-2.5 text-xs text-chili">
          {error}
        </div>
      )}

      {/* Save result */}
      {saveResult && saveResult.length > 0 && (
        <div className="rounded border border-leaf-deep/30 bg-leaf-deep/5 px-4 py-3 text-xs text-leaf-deep">
          <p className="font-semibold mb-1">Saved — stock updated by difference</p>
          {saveResult.map((r, i) => (
            <p key={i}>
              {r.product}: {r.old_qty} → {r.new_qty}
              <span className={r.delta > 0 ? " text-chili" : " text-leaf-deep"}>
                {" "}({r.delta > 0 ? "+" : ""}{r.delta})
              </span>
            </p>
          ))}
        </div>
      )}

      {/* Rebuild result */}
      {rebuildStock && (
        <div className="rounded border border-ink/10 bg-paper">
          <div className="border-b border-ink/10 px-4 py-2.5">
            <p className="text-xs font-semibold text-ink">Rebuild complete — current stock</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-ink/10">
                  <th className="px-4 py-2 text-left text-ink-soft font-medium">Ingredient</th>
                  <th className="px-4 py-2 text-right text-ink-soft font-medium">Qty</th>
                  <th className="px-4 py-2 text-left text-ink-soft font-medium">Unit</th>
                </tr>
              </thead>
              <tbody>
                {rebuildStock.map((s) => (
                  <tr key={s.ingredient} className="border-b border-ink/5">
                    <td className="px-4 py-1.5 text-ink">{s.ingredient}</td>
                    <td className={`px-4 py-1.5 text-right font-mono font-semibold ${s.negative ? "text-chili" : "text-ink"}`}>
                      {s.quantity % 1 === 0 ? s.quantity : s.quantity.toFixed(1)}
                    </td>
                    <td className="px-4 py-1.5 text-ink-soft">{s.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Main table + add panel */}
      {!loading && rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-ink/10">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="bg-action text-paper text-xs uppercase tracking-wide">
                  <th className="px-4 py-2.5 text-left font-semibold">Product</th>
                  <th className="px-4 py-2.5 text-center font-semibold w-24">Current</th>
                  <th className="px-4 py-2.5 text-center font-semibold w-28">Correct to</th>
                  <th className="px-4 py-2.5 text-center font-semibold w-20">Change</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-xs text-ink-soft">
                      No sales recorded for this day. Use "Add product" below to enter sales.
                    </td>
                  </tr>
                )}
                {tableRows.map((row, i) => {
                  const isNew = isNewRow(row);
                  const diff = diffInfo(row);
                  const val = edits[row.product_id] ?? String(row.quantity_sold);
                  const parsed = parseInt(val, 10);
                  const invalid = !isNaN(parsed) && parsed < row.app_sold;

                  return (
                    <tr
                      key={row.product_id}
                      className={`border-b border-ink/5 ${
                        isNew
                          ? "bg-leaf-deep/5"
                          : i % 2 === 0
                          ? "bg-paper"
                          : "bg-ink/[0.025]"
                      }`}
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="font-medium text-ink text-xs leading-tight">
                            {row.name}
                          </div>
                          {isNew && (
                            <span className="rounded-full bg-leaf-deep/15 px-1.5 py-0.5 text-[10px] font-semibold text-leaf-deep">
                              New
                            </span>
                          )}
                        </div>
                        {row.category && (
                          <div className="text-[10px] text-ink-soft mt-0.5">{row.category}</div>
                        )}
                        {row.app_sold > 0 && (
                          <div className="text-[10px] text-ink-soft mt-0.5">
                            {row.app_sold} from apps (min)
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center font-mono text-xs text-ink-soft">
                        {isNew ? "—" : row.quantity_sold}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <input
                          type="number"
                          min={row.app_sold}
                          className={`w-20 rounded border px-2 py-1 text-center font-mono text-xs outline-none focus:ring-1 ${
                            invalid
                              ? "border-chili/60 bg-chili/5 text-chili focus:ring-chili/30"
                              : diff
                              ? "border-gold/60 bg-gold/5 focus:ring-gold/30"
                              : "border-ink/20 bg-paper focus:ring-ink/20"
                          }`}
                          value={val}
                          onChange={(e) => handleEdit(row.product_id, e.target.value)}
                        />
                        {invalid && (
                          <div className="mt-0.5 text-[10px] text-chili">min {row.app_sold}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center font-mono text-xs">
                        {diff ? (
                          <span className={`font-semibold ${diff.positive ? "text-chili" : "text-leaf-deep"}`}>
                            {diff.positive ? "+" : ""}{diff.d}
                          </span>
                        ) : (
                          <span className="text-ink/25">—</span>
                        )}
                      </td>
                      <td className="pr-3 text-center">
                        {isNew && (
                          <button
                            onClick={() => removeAdded(row.product_id)}
                            className="text-ink/30 hover:text-chili text-xs leading-none"
                            title="Remove"
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Add product panel */}
          <div className="relative" ref={addPanelRef}>
            <button
              className="flex items-center gap-1.5 rounded border border-dashed border-ink/30 px-4 py-2 text-xs text-ink-soft hover:border-ink/50 hover:text-ink transition-colors"
              onClick={() => setAddOpen((v) => !v)}
            >
              <span className="text-base leading-none">+</span>
              Add product
            </button>

            {addOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-ink/15 bg-paper shadow-lg">
                <div className="border-b border-ink/10 p-2">
                  <input
                    ref={addSearchRef}
                    type="text"
                    className="w-full rounded border border-ink/20 px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ink/20"
                    placeholder="Search product…"
                    value={addSearch}
                    onChange={(e) => setAddSearch(e.target.value)}
                  />
                </div>

                <div className="max-h-64 overflow-y-auto">
                  {addableGrouped.length === 0 && (
                    <p className="px-3 py-4 text-center text-xs text-ink-soft">
                      {addSearch ? "No matches" : "All products already in the table"}
                    </p>
                  )}
                  {addableGrouped.map(([cat, catRows]) => (
                    <div key={cat}>
                      <div className="sticky top-0 bg-paper/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                        {cat}
                      </div>
                      {catRows.map((row) => (
                        <button
                          key={row.product_id}
                          className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-ink/5 transition-colors"
                          onClick={() => addProduct(row)}
                        >
                          {row.name}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Save bar */}
          <div className="flex items-center gap-4">
            <button
              className="btn btn-primary !py-2 !px-6 !text-sm disabled:opacity-40"
              onClick={handleSave}
              disabled={changedRows.length === 0 || saving}
            >
              {saving
                ? "Saving…"
                : changedRows.length === 0
                ? "No changes"
                : `Save ${changedRows.length} change${changedRows.length > 1 ? "s" : ""}`}
            </button>
            {changedRows.length > 0 && (
              <p className="text-xs text-ink-soft">
                Stock adjusts by the exact difference — no full rebuild needed.
              </p>
            )}
          </div>
        </>
      )}

      {!loading && rows.length === 0 && (
        <p className="text-xs text-ink-soft py-6 text-center">
          Select a date and click Load.
        </p>
      )}
    </div>
  );
}
