"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { today } from "@/lib/format";
import type {
  ExtractCandidate,
  ExtractResult,
  Ingredient,
  IngredientGroup,
  Paginated,
  TrackingMode,
} from "@/lib/types";

const GROUPS: { value: IngredientGroup; label: string }[] = [
  { value: "CHICKEN_PIECE", label: "Chicken — Main" },
  { value: "SNACK",         label: "Snacks & Balls" },
  { value: "BURGER_WRAP",   label: "Burgers & Wraps" },
  { value: "BEVERAGE",      label: "Beverages" },
  { value: "SUPPLY",        label: "Supplies" },
  { value: "OTHER",         label: "Other" },
];

const UNITS = ["piece", "portion", "gram", "ml", "bag"];

interface Row {
  raw_text: string;
  include: boolean;
  name: string;
  base_unit: string;
  pieces_per_pack: string;
  tracking_mode: TrackingMode;
  seen_in_slips: number;
  flagged: boolean;
}

interface EditDraft {
  name: string;
  base_unit: string;
  tracking_mode: TrackingMode;
  group: IngredientGroup;
  pieces_per_pack: string;
  cost_per_pack: string;
}

function toRow(c: ExtractCandidate): Row {
  return {
    raw_text: c.raw_text,
    include: !c.is_probably_not_ingredient,
    name: c.suggested_name,
    base_unit: c.suggested_unit,
    pieces_per_pack: c.suggested_qty_per_pack != null ? String(c.suggested_qty_per_pack) : "",
    tracking_mode: "RECIPE_LINKED",
    seen_in_slips: c.seen_in_slips,
    flagged: c.is_probably_not_ingredient,
  };
}

export default function ExtractIngredients() {
  const [files, setFiles] = useState<File[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [showManual, setShowManual] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ name: "", base_unit: "", tracking_mode: "RECIPE_LINKED", group: "OTHER", pieces_per_pack: "", cost_per_pack: "" });
  const [editOrigPack, setEditOrigPack] = useState<{ pieces_per_pack: string; cost_per_pack: string }>({ pieces_per_pack: "", cost_per_pack: "" });
  const [editAliasId, setEditAliasId] = useState<number | null>(null);
  const [editAliasText, setEditAliasText] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [sortCol, setSortCol] = useState<"name" | "tracking_mode" | "base_unit">("tracking_mode");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  async function refresh() {
    const d = await api<Paginated<Ingredient>>("/ingredients/");
    setIngredients(d.results);
  }
  useEffect(() => {
    refresh();
  }, []);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((f) => [...f, ...Array.from(list)]);
  }
  function removeFile(i: number) {
    setFiles((f) => f.filter((_, idx) => idx !== i));
  }

  async function extract() {
    if (files.length === 0) return;
    setExtracting(true);
    setMsg("");
    setSummary("");
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("slips", f));
      const res = await api<ExtractResult>("/ingredients/extract-from-slips/", {
        method: "POST",
        body: fd,
      });
      setRows(res.candidates.map(toRow));
      setSummary(
        `${res.new_count} new item${res.new_count === 1 ? "" : "s"} found across ${res.slips_processed} slip${res.slips_processed === 1 ? "" : "s"}` +
          (res.skipped_existing ? ` · ${res.skipped_existing} already in system, skipped` : "")
      );
      if (res.new_count === 0) setMsg("No new ingredients — everything on these slips is already in the system.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setMsg("Auto-read is unavailable on the server — add ingredients manually below.");
        setShowManual(true);
      } else {
        setMsg("Extraction failed. Try clearer photos, or add manually below.");
      }
    } finally {
      setExtracting(false);
    }
  }

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
  }

  const selectedCount = rows.filter((r) => r.include && r.name.trim()).length;

  function toggleSort(col: typeof sortCol) {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  }

  function startEdit(ing: Ingredient) {
    setEditId(ing.id);
    const origPieces = ing.active_pack?.pieces_per_pack ?? "";
    const origCost   = ing.active_pack?.cost_per_pack   ?? "";
    const firstAlias = ing.aliases[0];
    setEditDraft({
      name: ing.name,
      base_unit: ing.base_unit,
      tracking_mode: ing.tracking_mode,
      group: ing.group,
      pieces_per_pack: origPieces,
      cost_per_pack: origCost,
    });
    setEditOrigPack({ pieces_per_pack: origPieces, cost_per_pack: origCost });
    setEditAliasId(firstAlias?.id ?? null);
    setEditAliasText(firstAlias?.alias_text ?? "");
  }

  async function saveEdit() {
    if (editId == null) return;
    setEditBusy(true);
    try {
      await api(`/ingredients/${editId}/`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editDraft.name,
          base_unit: editDraft.base_unit,
          tracking_mode: editDraft.tracking_mode,
          group: editDraft.group,
        }),
      });

      // Only version a new PackDefinition if the pack values actually changed.
      const packChanged =
        editDraft.pieces_per_pack !== editOrigPack.pieces_per_pack ||
        editDraft.cost_per_pack   !== editOrigPack.cost_per_pack;
      if (packChanged && editDraft.pieces_per_pack.trim()) {
        await api("/pack-definitions/", {
          method: "POST",
          body: JSON.stringify({
            ingredient: editId,
            pieces_per_pack: editDraft.pieces_per_pack,
            cost_per_pack: editDraft.cost_per_pack || "0",
            effective_from: today(),
          }),
        });
      }

      // Save alias: update existing or create new
      if (editAliasText.trim()) {
        if (editAliasId) {
          await api(`/supplier-aliases/${editAliasId}/`, {
            method: "PATCH",
            body: JSON.stringify({ alias_text: editAliasText.trim() }),
          });
        } else {
          await api("/supplier-aliases/", {
            method: "POST",
            body: JSON.stringify({ ingredient: editId, alias_text: editAliasText.trim() }),
          });
        }
      }

      setEditId(null);
      refresh();
    } catch {
      // leave form open so user can retry
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteIngredient(id: number) {
    try {
      await api(`/ingredients/${id}/`, { method: "DELETE" });
      refresh();
    } catch {
      setMsg("Could not delete ingredient — it may be in use.");
    }
  }

  async function addSelected() {
    const items = rows
      .filter((r) => r.include && r.name.trim())
      .map((r) => ({
        name: r.name.trim(),
        base_unit: r.base_unit,
        tracking_mode: r.tracking_mode,
        pieces_per_pack: r.pieces_per_pack || null,
        alias: r.raw_text,
      }));
    if (items.length === 0) return;
    setSaving(true);
    setMsg("");
    try {
      await api("/ingredients/bulk-create/", {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      setMsg(`Added ${items.length} ingredient(s) ✓`);
      setRows([]);
      setFiles([]);
      setSummary("");
      refresh();
    } catch {
      setMsg("Could not add ingredients.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-xl font-bold">Extract ingredients</h1>
        <p className="text-xs text-ink-soft">
          Upload every slip you have — the system pulls out unique line items, drops the ones
          already in your catalog, and lets you add the rest with a clean name, unit and pack size.
        </p>
      </div>

      {/* Upload zone */}
      <div
        className="rounded-xl border-2 border-dashed border-[#c9bd9d] bg-[#fffdf7]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const dropped = Array.from(e.dataTransfer.files);
          setFiles((f) => [...f, ...dropped]);
        }}
      >
        <label
          className="block cursor-pointer px-4 py-8 text-center"
          style={{ touchAction: "manipulation" }}
        >
          <p className="font-display text-sm font-bold">+ Drop slip photos here, or click to browse</p>
          <p className="mt-1 font-mono text-[11px] text-ink-soft">JPG or PNG — upload as many as you have</p>
          <input
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(e) => {
              const selected = Array.from(e.target.files ?? []);
              e.target.value = "";
              setFiles((f) => [...f, ...selected]);
            }}
          />
        </label>
      </div>

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-full bg-paper-dim px-3 py-1 font-mono text-[11px]">
              📄 {f.name}
              <button className="text-ink-soft" onClick={() => removeFile(i)}>✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button className="btn btn-primary w-44" disabled={files.length === 0 || extracting} onClick={extract}>
          {extracting ? "Reading slips…" : "Extract items"}
        </button>
        {files.length > 0 && !extracting && (
          <span className="font-mono text-[11px] text-ink-soft">{files.length} file{files.length > 1 ? "s" : ""} ready</span>
        )}
      </div>

      {summary && <h2 className="sec">{summary}</h2>}
      {msg && <p className="font-mono text-xs text-ink-soft">{msg}</p>}

      {/* Review rows */}
      {rows.length > 0 && (
        <>
          <p className="text-xs text-ink-soft">
            Uncheck anything that isn&apos;t an ingredient. Give it a clean internal name, pick the
            unit recipes should use (&quot;portion&quot; for sauces, not &quot;bottle&quot;), and how many of that unit
            come in one pack. This is the one place you enter this.
          </p>
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <div
                key={i}
                className={`rounded border px-3 py-2.5 ${
                  row.include ? "border-[#d8cdb0] bg-[#fffdf7]" : "border-[#e4dcc8] bg-paper-dim/60 opacity-70"
                }`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={row.include}
                    onChange={(e) => updateRow(i, { include: e.target.checked })}
                  />
                  <span className="flex-1 font-mono text-[11px] text-ink-soft">
                    slip: "{row.raw_text}"
                    {row.flagged && (
                      <span className="ml-1 rounded bg-chili/15 px-1 py-0.5 text-[9px] uppercase text-chili-deep">
                        not a product?
                      </span>
                    )}
                  </span>
                  <span className="rounded-full bg-paper-dim px-2 py-0.5 font-mono text-[10px] text-ink-soft">
                    {row.seen_in_slips}× slips
                  </span>
                  <button className="font-mono text-ink-soft" onClick={() => removeRow(i)}>
                    ✕
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <label className="col-span-2 flex flex-col gap-0.5">
                    <span className="field-label">Ingredient name</span>
                    <input
                      className="field-input !py-1"
                      value={row.name}
                      onChange={(e) => updateRow(i, { name: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="field-label">Unit</span>
                    <input
                      list="unit-options"
                      className="field-input !py-1"
                      value={row.base_unit}
                      onChange={(e) => updateRow(i, { base_unit: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="field-label">Qty / pack</span>
                    <input
                      className="field-input !py-1 text-center"
                      inputMode="decimal"
                      value={row.pieces_per_pack}
                      onChange={(e) => updateRow(i, { pieces_per_pack: e.target.value })}
                    />
                  </label>
                  <label className="col-span-2 flex flex-col gap-0.5 sm:col-span-4">
                    <span className="field-label">Tracking</span>
                    <select
                      className="field-input !py-1"
                      value={row.tracking_mode}
                      onChange={(e) => updateRow(i, { tracking_mode: e.target.value as TrackingMode })}
                    >
                      <option value="RECIPE_LINKED">Recipe-linked (bun, patty, sauce…)</option>
                      <option value="PERIODIC_COUNT">Periodic count (bags, packets…)</option>
                      <option value="ONE_TIME">One-time purchase (tools, equipment…)</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
          </div>
          <datalist id="unit-options">
            {UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <button className="btn btn-primary w-56" disabled={saving || selectedCount === 0} onClick={addSelected}>
            {saving ? "Adding…" : `Add ${selectedCount} selected ingredient${selectedCount === 1 ? "" : "s"}`}
          </button>
        </>
      )}

      {/* Manual add (fallback / no-slip items) */}
      <div>
        <button
          className="font-mono text-[11px] text-gold-deep underline"
          onClick={() => setShowManual((s) => !s)}
        >
          {showManual ? "− Hide manual add" : "+ Add one manually (no slip)"}
        </button>
        {showManual && <ManualAdd onAdded={refresh} />}
      </div>

      <h2 className="sec">Ingredients ({ingredients.length})</h2>
      <div className="overflow-x-auto">
        <table className="datatable min-w-[700px]">
          <thead>
            <tr>
              {(["name", "base_unit", "tracking_mode"] as const).map((col) => (
                <th
                  key={col}
                  className="cursor-pointer select-none whitespace-nowrap"
                  onClick={() => toggleSort(col)}
                >
                  {col === "name" ? "Ingredient" : col === "base_unit" ? "Unit" : "Tracking"}
                  {sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕"}
                </th>
              ))}
              <th>Group</th>
              <th>Alias (display name)</th>
              <th>Qty / pack</th>
              <th>Cost / pack (৳)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...ingredients]
              .sort((a, b) => {
                const av = a[sortCol].toLowerCase();
                const bv = b[sortCol].toLowerCase();
                return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
              })
              .map((ing) =>
              editId === ing.id ? (
                <tr key={ing.id} className="bg-[#fffdf7]">
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
                      list="unit-options"
                      className="field-input !py-0.5 !text-xs w-full"
                      value={editDraft.base_unit}
                      onChange={(e) => setEditDraft((d) => ({ ...d, base_unit: e.target.value }))}
                    />
                  </td>
                  <td>
                    <select
                      className="field-input !py-0.5 !text-xs w-full"
                      value={editDraft.tracking_mode}
                      onChange={(e) => setEditDraft((d) => ({ ...d, tracking_mode: e.target.value as TrackingMode }))}
                    >
                      <option value="RECIPE_LINKED">Recipe-linked</option>
                      <option value="PERIODIC_COUNT">Periodic count</option>
                      <option value="ONE_TIME">One-time purchase</option>
                    </select>
                  </td>
                  <td>
                    <select
                      className="field-input !py-0.5 !text-xs w-full"
                      value={editDraft.group}
                      onChange={(e) => setEditDraft((d) => ({ ...d, group: e.target.value as IngredientGroup }))}
                    >
                      {GROUPS.map((g) => (
                        <option key={g.value} value={g.value}>{g.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="field-input !py-0.5 !text-xs w-full"
                      placeholder="e.g. Zinger Fillet"
                      value={editAliasText}
                      onChange={(e) => setEditAliasText(e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="field-input !py-0.5 !text-xs w-full"
                      inputMode="decimal"
                      placeholder="e.g. 10"
                      value={editDraft.pieces_per_pack}
                      onChange={(e) => setEditDraft((d) => ({ ...d, pieces_per_pack: e.target.value }))}
                    />
                  </td>
                  <td>
                    <input
                      className="field-input !py-0.5 !text-xs w-full"
                      inputMode="decimal"
                      placeholder="e.g. 950"
                      value={editDraft.cost_per_pack}
                      onChange={(e) => setEditDraft((d) => ({ ...d, cost_per_pack: e.target.value }))}
                    />
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
                      <button className="font-mono text-[11px] text-ink-soft" onClick={() => setEditId(null)}>
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={ing.id}>
                  <td className="text-ink-soft text-[11px]">{ing.name}</td>
                  <td>{ing.base_unit}</td>
                  <td>
                    <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                      ing.tracking_mode === "RECIPE_LINKED" ? "bg-leaf-deep/10 text-leaf-deep" :
                      ing.tracking_mode === "PERIODIC_COUNT" ? "bg-gold/20 text-gold-deep" :
                      "bg-paper-dim text-ink-soft"
                    }`}>
                      {ing.tracking_mode === "RECIPE_LINKED" ? "Recipe" :
                       ing.tracking_mode === "PERIODIC_COUNT" ? "Periodic" : "One-time"}
                    </span>
                  </td>
                  <td className="font-mono text-[10px] text-ink-soft">
                    {GROUPS.find((g) => g.value === ing.group)?.label ?? ing.group}
                  </td>
                  <td className="font-mono font-medium text-ink">
                    {ing.aliases[0]?.alias_text || <span className="text-ink-soft/50">—</span>}
                  </td>
                  <td className="font-mono text-xs">{ing.active_pack?.pieces_per_pack ?? "—"}</td>
                  <td className="font-mono text-xs">{ing.active_pack?.cost_per_pack ? `৳${ing.active_pack.cost_per_pack}` : "—"}</td>
                  <td>
                    <div className="flex gap-3">
                      <button className="font-mono text-[11px] text-gold-deep" onClick={() => startEdit(ing)}>Edit</button>
                      <button className="font-mono text-[11px] text-chili" onClick={() => deleteIngredient(ing.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              )
            )}
            {ingredients.length === 0 && (
              <tr><td colSpan={8} className="text-ink-soft">No ingredients yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ManualAdd({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [baseUnit, setBaseUnit] = useState("piece");
  const [tracking, setTracking] = useState<TrackingMode>("RECIPE_LINKED");
  const [piecesPerPack, setPiecesPerPack] = useState("");
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg("");
    try {
      const ing = await api<Ingredient>("/ingredients/", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), base_unit: baseUnit, tracking_mode: tracking }),
      });
      if (piecesPerPack) {
        await api("/pack-definitions/", {
          method: "POST",
          body: JSON.stringify({
            ingredient: ing.id,
            pieces_per_pack: piecesPerPack,
            cost_per_pack: "0",
            effective_from: today(),
          }),
        });
      }
      if (alias.trim()) {
        await api("/supplier-aliases/", {
          method: "POST",
          body: JSON.stringify({ ingredient: ing.id, alias_text: alias.trim() }),
        });
      }
      setName("");
      setPiecesPerPack("");
      setAlias("");
      setMsg(`Added "${ing.name}" ✓`);
      onAdded();
    } catch {
      setMsg("Could not add ingredient.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ownerpanel mt-2 flex flex-col gap-3">
      <div className="formgrid">
        <label className="field">
          <span className="field-label">Ingredient name</span>
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Crispy Chicken Patty (5in)" />
        </label>
        <label className="field">
          <span className="field-label">Base unit</span>
          <select className="field-input" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Tracking</span>
          <select className="field-input" value={tracking} onChange={(e) => setTracking(e.target.value as TrackingMode)}>
            <option value="RECIPE_LINKED">Recipe-linked</option>
            <option value="PERIODIC_COUNT">Periodic count</option>
            <option value="ONE_TIME">One-time purchase</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Pieces / pack</span>
          <input className="field-input" inputMode="decimal" value={piecesPerPack} onChange={(e) => setPiecesPerPack(e.target.value)} placeholder="10" />
        </label>
        <label className="field">
          <span className="field-label">Supplier alias</span>
          <input className="field-input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="CKN PATTY 5IN 10PC" />
        </label>
      </div>
      <button className="btn btn-primary w-44" disabled={busy} onClick={add}>
        {busy ? "Adding…" : "+ Add ingredient"}
      </button>
      {msg && <p className="font-mono text-xs text-ink-soft">{msg}</p>}
    </div>
  );
}
