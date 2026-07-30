"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import type { Paginated, Product, Recipe, RecipeProductComponent } from "@/lib/types";

export default function EditRecipe() {
  const params = useParams();
  const productId = Number(params.id);
  const [product, setProduct] = useState<Product | null>(null);
  const [rows, setRows] = useState<Recipe[]>([]);
  const [compRows, setCompRows] = useState<RecipeProductComponent[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function refresh() {
    // No product-detail endpoint filter needed — list is small.
    const d = await api<Paginated<Product>>("/products/");
    const p = d.results.find((x) => x.id === productId) ?? null;
    setProduct(p);
    setRows(p?.recipes ?? []);
    setCompRows(p?.product_recipe_components ?? []);
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  function setQty(id: number, value: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, quantity_per_unit: value } : r)));
  }

  function setPrimary(id: number) {
    setRows((rs) => rs.map((r) => ({ ...r, is_primary: r.id === id })));
  }

  function setCompQty(id: number, value: string) {
    setCompRows((rs) => rs.map((r) => (r.id === id ? { ...r, quantity_per_unit: value } : r)));
  }

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      for (const r of rows) {
        await api(`/recipes/${r.id}/`, {
          method: "PATCH",
          body: JSON.stringify({ quantity_per_unit: r.quantity_per_unit, is_primary: r.is_primary }),
        });
      }
      for (const c of compRows) {
        await api(`/recipe-product-components/${c.id}/`, {
          method: "PATCH",
          body: JSON.stringify({ quantity_per_unit: c.quantity_per_unit }),
        });
      }
      setMsg("Saved ✓");
      refresh();
    } catch {
      setMsg("Save failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!product) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-xl font-bold">Edit recipe — {product.name}</h1>
        <p className="text-xs text-ink-soft">
          How much of each ingredient one {product.name} consumes. Add or remove ingredients in Map recipes.
        </p>
      </div>

      <div className="ownerpanel flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Raw ingredients</p>
          {rows.length > 1 && (
            <p className="font-mono text-[9px] text-ink-soft">Primary = pack size reference</p>
          )}
        </div>
        {rows.map((r) => (
          <div key={r.id} className="grid grid-cols-[1fr_100px_auto] items-center gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {rows.length > 1 && (
                <button
                  type="button"
                  title={r.is_primary ? "Primary ingredient" : "Set as primary"}
                  onClick={() => setPrimary(r.is_primary ? -1 : r.id)}
                  className={`shrink-0 flex h-5 w-5 items-center justify-center rounded-full border text-[10px] transition-colors ${
                    r.is_primary
                      ? "border-gold bg-gold text-white"
                      : "border-[#d8cdb0] text-ink-soft hover:border-gold"
                  }`}
                >
                  ★
                </button>
              )}
              <span className="font-display text-sm truncate">{r.ingredient_name}</span>
            </div>
            <input
              className="field-input !py-1 text-center"
              inputMode="decimal"
              value={r.quantity_per_unit}
              onChange={(e) => setQty(r.id, e.target.value)}
            />
            <span className="font-mono text-[11px] text-ink-soft">{r.base_unit}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="font-mono text-xs text-ink-soft">No ingredients assigned. Assign them in Map recipes first.</p>
        )}
        {rows.length > 1 && (
          <p className="font-mono text-[10px] text-ink-soft">
            {rows.some((r) => r.is_primary)
              ? `★ ${rows.find((r) => r.is_primary)!.ingredient_name} is the primary — pack size for prep logging.`
              : "No primary set — prep logging will be piece-only. Tap ★ to designate one."}
          </p>
        )}
      </div>

      {compRows.length > 0 && (
        <div className="ownerpanel flex flex-col gap-3">
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Derived from (menu items)</p>
          {compRows.map((c) => (
            <div key={c.id} className="grid grid-cols-[1fr_100px_auto] items-center gap-2">
              <span className="font-display text-sm">{c.component_name}</span>
              <input
                className="field-input !py-1 text-center"
                inputMode="decimal"
                value={c.quantity_per_unit}
                onChange={(e) => setCompQty(c.id, e.target.value)}
              />
              <span className="font-mono text-[11px] text-ink-soft">pcs</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button className="btn btn-primary w-40" disabled={busy || (rows.length === 0 && compRows.length === 0)} onClick={save}>
          {busy ? "Saving…" : "Save quantities"}
        </button>
        <Link href="/owner/setup/map-recipes" className="btn btn-ghost w-40">
          Map recipes
        </Link>
      </div>
      {msg && <p className="font-mono text-xs text-ink-soft">{msg}</p>}
    </div>
  );
}
