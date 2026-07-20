"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { bdt } from "@/lib/format";
import type { Paginated, Product } from "@/lib/types";

interface MenuCandidate {
  name: string;
  category: string;
  selling_price: number | null;
  requires_preparation: boolean;
  is_combo: boolean;
}

interface MenuExtractResult {
  photos_processed: number;
  new_count: number;
  candidates: MenuCandidate[];
}

interface Row {
  include: boolean;
  name: string;
  category: string;
  selling_price: string;
  requires_preparation: boolean;
}

function toRow(c: MenuCandidate): Row {
  return {
    include: true,
    name: c.name,
    category: c.category,
    selling_price: c.selling_price != null ? String(c.selling_price) : "",
    requires_preparation: c.requires_preparation,
  };
}

interface EditDraft {
  name: string;
  category: string;
  selling_price: string;
  requires_preparation: boolean;
}

const BLANK: Row = { include: true, name: "", category: "", selling_price: "", requires_preparation: true };

export default function ImportMenu() {
  const [photos, setPhotos] = useState<File[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [manualRows, setManualRows] = useState<Row[]>([{ ...BLANK }]);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ name: "", category: "", selling_price: "", requires_preparation: true });
  const [editBusy, setEditBusy] = useState(false);

  async function refresh() {
    const d = await api<Paginated<Product>>("/products/");
    setProducts(d.results);
  }
  useEffect(() => { refresh(); }, []);

  function removePhoto(i: number) {
    setPhotos((p) => p.filter((_, idx) => idx !== i));
  }

  async function extract() {
    if (photos.length === 0) return;
    setExtracting(true);
    setMsg("");
    setSummary("");
    try {
      const fd = new FormData();
      photos.forEach((f) => fd.append("photos", f));
      const res = await api<MenuExtractResult>("/products/extract-from-menu/", {
        method: "POST",
        body: fd,
      });
      setRows(res.candidates.map(toRow));
      setSummary(
        `${res.new_count} new item${res.new_count === 1 ? "" : "s"} found across ${res.photos_processed} photo${res.photos_processed === 1 ? "" : "s"}`
      );
      if (res.new_count === 0) setMsg("No new menu items found — all items from these photos are already in the catalog.");
    } catch (err) {
      const detail = err instanceof ApiError
        ? (err.body as { detail?: string })?.detail
        : undefined;
      setMsg(detail ?? "Extraction failed. Try a clearer photo, or add manually below.");
    } finally {
      setExtracting(false);
    }
  }

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function updateManual(i: number, patch: Partial<Row>) {
    setManualRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function startEdit(p: Product) {
    setEditId(p.id);
    setEditDraft({
      name: p.name,
      category: p.category ?? "",
      selling_price: p.selling_price != null ? String(p.selling_price) : "",
      requires_preparation: p.requires_preparation,
    });
  }

  async function saveEdit() {
    if (editId == null) return;
    setEditBusy(true);
    try {
      await api(`/products/${editId}/`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editDraft.name.trim(),
          category: editDraft.category.trim(),
          selling_price: editDraft.selling_price || "0",
          requires_preparation: editDraft.requires_preparation,
        }),
      });
      setEditId(null);
      refresh();
    } catch {
      // leave form open on error
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteProduct(id: number) {
    try {
      await api(`/products/${id}/`, { method: "DELETE" });
      refresh();
    } catch {
      setMsg("Could not delete product — it may be in use.");
    }
  }

  const selectedCount = rows.filter((r) => r.include && r.name.trim()).length;
  const manualCount = manualRows.filter((r) => r.name.trim()).length;

  async function importRows(items: Row[]) {
    const valid = items.filter((r) => r.include !== false && r.name.trim());
    if (valid.length === 0) return;
    setBusy(true);
    setMsg("");
    try {
      for (const r of valid) {
        await api("/products/", {
          method: "POST",
          body: JSON.stringify({
            name: r.name.trim(),
            category: r.category.trim(),
            product_type: "SINGLE",
            requires_preparation: r.requires_preparation,
            selling_price: r.selling_price || "0",
          }),
        });
      }
      setMsg(`Imported ${valid.length} product(s) ✓ — assign ingredients in Map recipes.`);
      setRows([]);
      setPhotos([]);
      setSummary("");
      setManualRows([{ ...BLANK }]);
      refresh();
    } catch {
      setMsg("Import failed for one or more rows.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-xl font-bold">Import menu</h1>
        <p className="text-xs text-ink-soft">
          Upload a menu photo and the system extracts sellable items. Review, then import. Recipes are assigned separately in Map recipes.
        </p>
      </div>

      {/* Upload zone */}
      <div
        className="rounded-xl border-2 border-dashed border-[#c9bd9d] bg-[#fffdf7]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const dropped = Array.from(e.dataTransfer.files);
          setPhotos((p) => [...p, ...dropped]);
        }}
      >
        <label
          className="block cursor-pointer px-4 py-8 text-center"
          style={{ touchAction: "manipulation" }}
        >
          <p className="font-display text-sm font-bold">+ Drop menu photos here, or click to browse</p>
          <p className="mt-1 font-mono text-[11px] text-ink-soft">JPG or PNG — menu board, printed menu, app screenshot</p>
          <input
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(e) => {
              const selected = Array.from(e.target.files ?? []);
              e.target.value = "";
              setPhotos((p) => [...p, ...selected]);
            }}
          />
        </label>
      </div>

      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {photos.map((f, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-full bg-paper-dim px-3 py-1 font-mono text-[11px]">
              📄 {f.name}
              <button className="text-ink-soft" onClick={() => removePhoto(i)}>✕</button>
            </span>
          ))}
        </div>
      )}

      <button
        className="btn btn-primary w-44"
        disabled={photos.length === 0 || extracting}
        onClick={extract}
      >
        {extracting ? "Reading menu…" : "Extract items"}
      </button>

      {summary && <h2 className="sec">{summary}</h2>}
      {msg && <p className="font-mono text-xs text-ink-soft">{msg}</p>}

      {/* Extracted review rows */}
      {rows.length > 0 && (
        <>
          <p className="text-xs text-ink-soft">
            Uncheck anything that isn&apos;t a menu item. Edit name, category, and price before importing.
          </p>
          <div className="ownerpanel flex flex-col gap-2">
            <div className="grid grid-cols-[24px_1fr_1fr_90px_90px] gap-2 font-mono text-[9px] uppercase tracking-wide text-ink-soft">
              <span />
              <span>Name</span>
              <span>Category</span>
              <span>Price ৳</span>
              <span>Prepared?</span>
            </div>
            {rows.map((r, i) => (
              <div
                key={i}
                className={`grid grid-cols-[24px_1fr_1fr_90px_90px] items-center gap-2 ${!r.include ? "opacity-50" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={r.include}
                  onChange={(e) => updateRow(i, { include: e.target.checked })}
                />
                <input className="field-input !py-1" value={r.name} onChange={(e) => updateRow(i, { name: e.target.value })} />
                <input className="field-input !py-1" value={r.category} onChange={(e) => updateRow(i, { category: e.target.value })} />
                <input className="field-input !py-1" inputMode="decimal" value={r.selling_price} onChange={(e) => updateRow(i, { selling_price: e.target.value })} />
                <select
                  className="field-input !py-1"
                  value={r.requires_preparation ? "yes" : "no"}
                  onChange={(e) => updateRow(i, { requires_preparation: e.target.value === "yes" })}
                >
                  <option value="yes">Prep</option>
                  <option value="no">Direct</option>
                </select>
              </div>
            ))}
          </div>
          <button
            className="btn btn-primary w-56"
            disabled={busy || selectedCount === 0}
            onClick={() => importRows(rows)}
          >
            {busy ? "Importing…" : `Import ${selectedCount} selected item${selectedCount === 1 ? "" : "s"}`}
          </button>
        </>
      )}

      {/* Manual add (always available) */}
      <div className="ownerpanel flex flex-col gap-2">
        <h2 className="sec">Add manually</h2>
        <div className="grid grid-cols-[1fr_1fr_90px_90px_28px] gap-2 font-mono text-[9px] uppercase tracking-wide text-ink-soft">
          <span>Name</span>
          <span>Category</span>
          <span>Price ৳</span>
          <span>Prepared?</span>
          <span />
        </div>
        {manualRows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_90px_90px_28px] items-center gap-2">
            <input className="field-input !py-1" value={r.name} onChange={(e) => updateManual(i, { name: e.target.value })} />
            <input className="field-input !py-1" value={r.category} onChange={(e) => updateManual(i, { category: e.target.value })} />
            <input className="field-input !py-1" inputMode="decimal" value={r.selling_price} onChange={(e) => updateManual(i, { selling_price: e.target.value })} />
            <select
              className="field-input !py-1"
              value={r.requires_preparation ? "yes" : "no"}
              onChange={(e) => updateManual(i, { requires_preparation: e.target.value === "yes" })}
            >
              <option value="yes">Prep</option>
              <option value="no">Direct</option>
            </select>
            <button className="font-mono text-ink-soft" onClick={() => setManualRows((rs) => rs.filter((_, idx) => idx !== i))}>✕</button>
          </div>
        ))}
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => setManualRows((rs) => [...rs, { ...BLANK }])}>
            + Row
          </button>
          <button className="btn btn-primary" disabled={busy || manualCount === 0} onClick={() => importRows(manualRows)}>
            {busy ? "Importing…" : "Import all"}
          </button>
        </div>
      </div>

      <h2 className="sec">Menu ({products.length})</h2>
      <div className="overflow-x-auto">
        <table className="datatable min-w-[560px]">
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Price ৳</th>
              <th>Prepared?</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) =>
              editId === p.id ? (
                <tr key={p.id} className="bg-[#fffdf7]">
                  <td>
                    <input
                      className="field-input !py-0.5 !text-xs w-full"
                      value={editDraft.name}
                      onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                      autoFocus
                    />
                  </td>
                  <td>
                    <input
                      className="field-input !py-0.5 !text-xs w-full"
                      value={editDraft.category}
                      onChange={(e) => setEditDraft((d) => ({ ...d, category: e.target.value }))}
                    />
                  </td>
                  <td>
                    <input
                      className="field-input !py-0.5 !text-xs w-full"
                      inputMode="decimal"
                      value={editDraft.selling_price}
                      onChange={(e) => setEditDraft((d) => ({ ...d, selling_price: e.target.value }))}
                    />
                  </td>
                  <td>
                    <select
                      className="field-input !py-0.5 !text-xs w-full"
                      value={editDraft.requires_preparation ? "yes" : "no"}
                      onChange={(e) => setEditDraft((d) => ({ ...d, requires_preparation: e.target.value === "yes" }))}
                    >
                      <option value="yes">Prep</option>
                      <option value="no">Direct</option>
                    </select>
                  </td>
                  <td>
                    <div className="flex gap-2">
                      <button
                        className="font-mono text-[11px] text-green-700 disabled:opacity-50"
                        disabled={editBusy || !editDraft.name.trim()}
                        onClick={saveEdit}
                      >
                        {editBusy ? "…" : "Save"}
                      </button>
                      <button
                        className="font-mono text-[11px] text-ink-soft"
                        onClick={() => setEditId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.category || "—"}</td>
                  <td>{bdt(p.selling_price)}</td>
                  <td>{p.requires_preparation ? "Prep" : "Direct"}</td>
                  <td>
                    <div className="flex gap-3">
                      <button
                        className="font-mono text-[11px] text-gold-deep"
                        onClick={() => startEdit(p)}
                      >
                        Edit
                      </button>
                      <button
                        className="font-mono text-[11px] text-chili"
                        onClick={() => deleteProduct(p.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              )
            )}
            {products.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-soft">No menu items yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Link href="/owner/setup/map-recipes" className="btn btn-ghost w-48">
        Next: Map recipes →
      </Link>
    </div>
  );
}
