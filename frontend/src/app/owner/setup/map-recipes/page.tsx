"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Ingredient, Paginated, Product, Recipe, RecipeProductComponent } from "@/lib/types";

interface PendingAssign {
  productId: number;
  ingredientId: number;
  qty: string;
}

interface PendingCompAssign {
  productId: number;
  componentProductId: number;
  qty: string;
}

export default function MapRecipes() {
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [pendingAssign, setPendingAssign] = useState<PendingAssign | null>(null);
  const [compPickerFor, setCompPickerFor] = useState<number | null>(null);
  const [pendingCompAssign, setPendingCompAssign] = useState<PendingCompAssign | null>(null);
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

  async function assignComp(product: Product, componentProductId: number, qty: string) {
    const quantity = parseFloat(qty) || 1;
    setBusy(true);
    try {
      await api("/recipe-product-components/", {
        method: "POST",
        body: JSON.stringify({ product: product.id, component_product: componentProductId, quantity_per_unit: quantity }),
      });
      await refresh();
    } finally {
      setBusy(false);
      setCompPickerFor(null);
      setPendingCompAssign(null);
    }
  }

  async function unassignComp(comp: RecipeProductComponent) {
    setBusy(true);
    try {
      await api(`/recipe-product-components/${comp.id}/`, { method: "DELETE" });
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

          const isCompPickerOpen = compPickerFor === p.id;
          const isPendingComp = pendingCompAssign?.productId === p.id;
          const pendingCompProduct = isPendingComp
            ? products.find((pp) => pp.id === pendingCompAssign!.componentProductId)
            : null;

          return (
            <div key={p.id} className="ownerpanel flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-bold">{p.name}</span>
                <Link href={`/owner/products/edit-recipe/${p.id}`} className="font-mono text-[10px] text-gold-deep underline">
                  set quantities
                </Link>
              </div>

              {/* Raw ingredients */}
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-soft">Raw ingredients</p>
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
                    <span className="font-mono text-[11px] text-ink-soft">None assigned.</span>
                  )}
                </div>
                {isPickerOpen ? (
                  isPending && pendingIngredient ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded bg-paper-dim p-2">
                      <span className="font-mono text-xs font-bold">{pendingIngredient.name}</span>
                      <span className="font-mono text-[10px] text-ink-soft">qty ({pendingIngredient.base_unit})</span>
                      <input
                        className="field-input !py-0.5 w-20 !text-xs"
                        type="number" inputMode="decimal" min="0.001" step="0.001"
                        value={pendingAssign!.qty}
                        onChange={(e) => setPendingAssign((pa) => (pa ? { ...pa, qty: e.target.value } : pa))}
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
                      >✓ Add</button>
                      <button className="font-mono text-xs text-ink-soft" onClick={() => setPendingAssign(null)}>✗</button>
                    </div>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 rounded bg-paper-dim p-2">
                      {ingredients
                        .filter((ing) => !p.recipes.some((r) => r.ingredient === ing.id))
                        .map((ing) => (
                          <button key={ing.id} className="chip" disabled={busy}
                            onClick={() => setPendingAssign({ productId: p.id, ingredientId: ing.id, qty: "1" })}>
                            + {ing.name}
                          </button>
                        ))}
                      {ingredients.filter((ing) => !p.recipes.some((r) => r.ingredient === ing.id)).length === 0 && (
                        <span className="font-mono text-[11px] text-ink-soft">All ingredients assigned.</span>
                      )}
                      <button className="chip" onClick={closePicker}>done</button>
                    </div>
                  )
                ) : (
                  <button className="btn btn-ghost mt-1.5 self-start !px-3 !py-1" onClick={() => openPicker(p.id)}>
                    + Assign ingredient
                  </button>
                )}
              </div>

              {/* Prepared product inputs */}
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-soft">Derived from (menu items)</p>
                <p className="mb-1.5 text-[10px] text-ink-soft">
                  Preparing this product pulls ready pieces of these items from display stock.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {p.product_recipe_components.map((c) => (
                    <button
                      key={c.id}
                      className="chip chip-active"
                      onClick={() => unassignComp(c)}
                      disabled={busy}
                      title="Remove"
                    >
                      {c.component_name} ×{c.quantity_per_unit} pcs ✕
                    </button>
                  ))}
                  {p.product_recipe_components.length === 0 && (
                    <span className="font-mono text-[11px] text-ink-soft">None assigned.</span>
                  )}
                </div>
                {isCompPickerOpen ? (
                  isPendingComp && pendingCompProduct ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded bg-paper-dim p-2">
                      <span className="font-mono text-xs font-bold">{pendingCompProduct.name}</span>
                      <span className="font-mono text-[10px] text-ink-soft">qty (pcs)</span>
                      <input
                        className="field-input !py-0.5 w-20 !text-xs"
                        type="number" inputMode="decimal" min="0.001" step="0.001"
                        value={pendingCompAssign!.qty}
                        onChange={(e) => setPendingCompAssign((pa) => (pa ? { ...pa, qty: e.target.value } : pa))}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") assignComp(p, pendingCompAssign!.componentProductId, pendingCompAssign!.qty);
                          if (e.key === "Escape") setPendingCompAssign(null);
                        }}
                      />
                      <button
                        className="font-mono text-xs text-green-700 disabled:opacity-40"
                        disabled={busy || !pendingCompAssign!.qty || Number(pendingCompAssign!.qty) <= 0}
                        onClick={() => assignComp(p, pendingCompAssign!.componentProductId, pendingCompAssign!.qty)}
                      >✓ Add</button>
                      <button className="font-mono text-xs text-ink-soft" onClick={() => setPendingCompAssign(null)}>✗</button>
                    </div>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 rounded bg-paper-dim p-2">
                      {(() => {
                        const available = products.filter(
                          (pp) =>
                            pp.id !== p.id &&
                            !p.product_recipe_components.some((c) => c.component_product === pp.id)
                        );
                        if (available.length === 0)
                          return (
                            <span className="font-mono text-[11px] text-ink-soft">
                              No other menu items available to select.
                            </span>
                          );
                        return available.map((pp) => (
                          <button
                            key={pp.id}
                            className="chip"
                            disabled={busy}
                            onClick={() => setPendingCompAssign({ productId: p.id, componentProductId: pp.id, qty: "1" })}
                          >
                            + {pp.name}
                          </button>
                        ));
                      })()}
                      <button className="chip" onClick={() => setCompPickerFor(null)}>done</button>
                    </div>
                  )
                ) : (
                  <button className="btn btn-ghost mt-1.5 self-start !px-3 !py-1" onClick={() => setCompPickerFor(p.id)}>
                    + Derived from menu item
                  </button>
                )}
              </div>
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
