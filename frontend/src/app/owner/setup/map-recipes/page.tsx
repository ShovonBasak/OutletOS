"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Ingredient, Paginated, Product, Recipe } from "@/lib/types";

interface PendingAssign {
  productId: number;
  ingredientId: number;
  qty: string;
}

export default function MapRecipes() {
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [pendingAssign, setPendingAssign] = useState<PendingAssign | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [p, ing] = await Promise.all([
      api<Paginated<Product>>("/products/?product_type=SINGLE"),
      api<Paginated<Ingredient>>("/ingredients/?tracking_mode=RECIPE_LINKED&active=true"),
    ]);
    setProducts(p.results);
    setIngredients(ing.results);
  }
  useEffect(() => { refresh(); }, []);

  function openPicker(productId: number) {
    setPickerFor(productId);
    setPendingAssign(null);
  }

  function closePicker() {
    setPickerFor(null);
    setPendingAssign(null);
  }

  async function assign(product: Product, ingredientId: number, qty: string) {
    const quantity = parseFloat(qty) || 1;
    setBusy(true);
    try {
      await api("/recipes/", {
        method: "POST",
        body: JSON.stringify({ product: product.id, ingredient: ingredientId, quantity_per_unit: quantity }),
      });
      await refresh();
    } finally {
      setBusy(false);
      closePicker();
    }
  }

  async function unassign(recipe: Recipe) {
    setBusy(true);
    try {
      await api(`/recipes/${recipe.id}/`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-xl font-bold">Map recipes</h1>
        <p className="text-xs text-ink-soft">
          Tap to assign which ingredients each product uses and set the quantity. Fine-tune quantities later in Edit recipe.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {products.map((p) => {
          const isPickerOpen = pickerFor === p.id;
          const isPending = pendingAssign?.productId === p.id;
          const pendingIngredient = isPending
            ? ingredients.find((ing) => ing.id === pendingAssign!.ingredientId)
            : null;

          return (
            <div key={p.id} className="ownerpanel flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-bold">{p.name}</span>
                <Link href={`/owner/products/edit-recipe/${p.id}`} className="font-mono text-[10px] text-gold-deep underline">
                  set quantities
                </Link>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {p.recipes.map((r) => (
                  <button
                    key={r.id}
                    className="chip chip-active"
                    onClick={() => unassign(r)}
                    disabled={busy}
                    title="Remove"
                  >
                    {r.ingredient_name} ×{r.quantity_per_unit} ✕
                  </button>
                ))}
                {p.recipes.length === 0 && (
                  <span className="font-mono text-[11px] text-ink-soft">No ingredients yet.</span>
                )}
              </div>

              {isPickerOpen ? (
                isPending && pendingIngredient ? (
                  /* Step 2: confirm quantity */
                  <div className="flex flex-wrap items-center gap-2 rounded bg-paper-dim p-2">
                    <span className="font-mono text-xs font-bold">{pendingIngredient.name}</span>
                    <span className="font-mono text-[10px] text-ink-soft">
                      qty ({pendingIngredient.base_unit})
                    </span>
                    <input
                      className="field-input !py-0.5 w-20 !text-xs"
                      type="number"
                      inputMode="decimal"
                      min="0.001"
                      step="0.001"
                      value={pendingAssign!.qty}
                      onChange={(e) =>
                        setPendingAssign((pa) => (pa ? { ...pa, qty: e.target.value } : pa))
                      }
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") assign(p, pendingAssign!.ingredientId, pendingAssign!.qty);
                        if (e.key === "Escape") setPendingAssign(null);
                      }}
                    />
                    <button
                      className="font-mono text-xs text-green-700 disabled:opacity-40"
                      disabled={busy || !pendingAssign!.qty || Number(pendingAssign!.qty) <= 0}
                      onClick={() => assign(p, pendingAssign!.ingredientId, pendingAssign!.qty)}
                    >
                      ✓ Add
                    </button>
                    <button className="font-mono text-xs text-ink-soft" onClick={() => setPendingAssign(null)}>
                      ✗
                    </button>
                  </div>
                ) : (
                  /* Step 1: pick ingredient */
                  <div className="flex flex-wrap gap-1.5 rounded bg-paper-dim p-2">
                    {ingredients
                      .filter((ing) => !p.recipes.some((r) => r.ingredient === ing.id))
                      .map((ing) => (
                        <button
                          key={ing.id}
                          className="chip"
                          disabled={busy}
                          onClick={() =>
                            setPendingAssign({ productId: p.id, ingredientId: ing.id, qty: "1" })
                          }
                        >
                          + {ing.name}
                        </button>
                      ))}
                    {ingredients.filter((ing) => !p.recipes.some((r) => r.ingredient === ing.id)).length === 0 && (
                      <span className="font-mono text-[11px] text-ink-soft">All ingredients assigned.</span>
                    )}
                    <button className="chip" onClick={closePicker}>
                      done
                    </button>
                  </div>
                )
              ) : (
                <button className="btn btn-ghost self-start !px-3 !py-1" onClick={() => openPicker(p.id)}>
                  + Assign ingredient
                </button>
              )}
            </div>
          );
        })}
      </div>

      {products.length === 0 && (
        <p className="font-mono text-xs text-ink-soft">No products yet — import your menu first.</p>
      )}
    </div>
  );
}
