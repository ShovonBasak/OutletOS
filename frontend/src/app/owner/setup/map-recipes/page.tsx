"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Ingredient, Paginated, Product, Recipe, RecipeProductComponent } from "@/lib/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function primaryAlias(ing: Ingredient | undefined): string | null {
  return ing?.aliases?.find((a) => a.is_active)?.alias_text ?? null;
}

function displayName(ing: Ingredient | undefined, fallback: string): string {
  return primaryAlias(ing) ?? fallback;
}

function subName(ing: Ingredient | undefined, fallback: string): string | null {
  return primaryAlias(ing) ? fallback : null;
}

const GROUP_ORDER = ["CHICKEN_PIECE", "SNACK", "BURGER_WRAP", "BEVERAGE", "SUPPLY", "OTHER"] as const;
const GROUP_LABELS: Record<string, string> = {
  CHICKEN_PIECE: "Chicken",
  SNACK: "Snacks",
  BURGER_WRAP: "Burger & Wrap",
  BEVERAGE: "Beverages",
  SUPPLY: "Supplies",
  OTHER: "Other",
};

// ── Ingredient list picker (inline, not floating) ─────────────────────────────

function IngredientList({
  ingredients,
  onSelect,
  onClose,
}: {
  ingredients: Ingredient[];
  onSelect: (ing: Ingredient) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return ingredients;
    return ingredients.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.aliases?.some((a) => a.is_active && a.alias_text.toLowerCase().includes(q))
    );
  }, [ingredients, search]);

  const groups = useMemo(() => {
    const map = new Map<string, Ingredient[]>();
    filtered.forEach((ing) => {
      const g = ing.group ?? "OTHER";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(ing);
    });
    const rank = (g: string) => {
      const i = GROUP_ORDER.indexOf(g as typeof GROUP_ORDER[number]);
      return i === -1 ? 999 : i;
    };
    return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b));
  }, [filtered]);

  const showGroups = groups.length > 1;

  return (
    <div className="mt-2 rounded-lg border border-[#d8cdb0] bg-paper-dim overflow-hidden">
      <div className="px-3 py-2 border-b border-[#d8cdb0] bg-paper">
        <input
          autoFocus
          className="field-input w-full text-sm"
          placeholder="Search ingredients or alias…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="px-4 py-5 text-center font-mono text-xs text-ink-soft">No matches.</p>
        )}
        {groups.map(([group, items]) => (
          <div key={group}>
            {showGroups && (
              <p className="sticky top-0 bg-paper-dim/95 px-3 py-1 font-mono text-[9px] uppercase tracking-widest text-ink-soft border-b border-[#e8e0cc]">
                {GROUP_LABELS[group] ?? group}
              </p>
            )}
            {items.map((ing) => {
              const alias = primaryAlias(ing);
              return (
                <button
                  key={ing.id}
                  type="button"
                  className="flex w-full items-center justify-between border-b border-dotted border-[#e8e0cc] px-4 py-2.5 text-left transition-colors hover:bg-paper active:bg-paper last:border-0"
                  onClick={() => onSelect(ing)}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-mono text-[13px] text-ink font-medium">
                      {alias ?? ing.name}
                    </span>
                    {alias && (
                      <span className="font-mono text-[10px] text-ink-soft">{ing.name}</span>
                    )}
                  </div>
                  <span className="shrink-0 pl-3 font-mono text-[10px] text-ink-soft">{ing.base_unit}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="border-t border-[#d8cdb0] px-3 py-2">
        <button className="font-mono text-[11px] text-ink-soft underline" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── product list picker (for "derived from menu item") ────────────────────────

function ProductList({
  products,
  onSelect,
  onClose,
}: {
  products: Product[];
  onSelect: (p: Product) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? products.filter((p) => p.name.toLowerCase().includes(q)) : products;
  }, [products, search]);

  return (
    <div className="mt-2 rounded-lg border border-[#d8cdb0] bg-paper-dim overflow-hidden">
      <div className="px-3 py-2 border-b border-[#d8cdb0] bg-paper">
        <input
          autoFocus
          className="field-input w-full text-sm"
          placeholder="Search menu items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="max-h-48 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="px-4 py-4 text-center font-mono text-xs text-ink-soft">No matches.</p>
        )}
        {filtered.map((p) => (
          <button
            key={p.id}
            type="button"
            className="flex w-full items-center justify-between border-b border-dotted border-[#e8e0cc] px-4 py-2.5 text-left hover:bg-paper last:border-0"
            onClick={() => onSelect(p)}
          >
            <span className="font-mono text-[13px] text-ink font-medium">{p.name}</span>
            <span className="font-mono text-[10px] text-ink-soft">{p.category}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-[#d8cdb0] px-3 py-2">
        <button className="font-mono text-[11px] text-ink-soft underline" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── inline qty confirm bar ────────────────────────────────────────────────────

function QtyConfirm({
  label,
  subLabel,
  unit,
  qty,
  onQtyChange,
  onConfirm,
  onCancel,
  busy,
}: {
  label: string;
  subLabel?: string | null;
  unit: string;
  qty: string;
  onQtyChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-action/40 bg-action/5 px-3 py-3">
      <div>
        <p className="font-mono text-[13px] font-semibold text-ink">{label}</p>
        {subLabel && <p className="font-mono text-[10px] text-ink-soft">{subLabel}</p>}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[11px] text-ink-soft">Qty per unit</span>
        <input
          autoFocus
          className="field-input !py-1 w-24 text-center font-mono"
          type="number"
          inputMode="decimal"
          min="0.001"
          step="0.001"
          value={qty}
          onChange={(e) => onQtyChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm();
            if (e.key === "Escape") onCancel();
          }}
        />
        <span className="font-mono text-[11px] text-ink-soft">{unit}</span>
        <button
          className="rounded bg-leaf px-3 py-1 font-mono text-[11px] text-white disabled:opacity-50"
          disabled={busy || !qty || Number(qty) <= 0}
          onClick={onConfirm}
        >
          ✓ Add
        </button>
        <button className="font-mono text-[11px] text-ink-soft underline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

type AddMode = "picker" | "qty";

interface PendingAdd {
  productId: number;
  mode: AddMode;
  ingredientId?: number;
  componentProductId?: number;
  qty: string;
}

export default function MapRecipes() {
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [ingById, setIngById] = useState<Map<number, Ingredient>>(new Map());

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [addIngFor, setAddIngFor] = useState<PendingAdd | null>(null);
  const [addCompFor, setAddCompFor] = useState<PendingAdd | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [p, ing] = await Promise.all([
      api<Paginated<Product>>("/products/?product_type=SINGLE"),
      api<Paginated<Ingredient>>("/ingredients/?tracking_mode=RECIPE_LINKED&active=true"),
    ]);
    setProducts(p.results);
    setIngredients(ing.results);
    const m = new Map<number, Ingredient>();
    ing.results.forEach((i) => m.set(i.id, i));
    setIngById(m);
  }

  useEffect(() => { refresh(); }, []);

  function toggleExpand(id: number) {
    setExpandedId((prev) => (prev === id ? null : id));
    setAddIngFor(null);
    setAddCompFor(null);
  }

  // ── ingredient assign ──
  function startAddIng(productId: number) {
    setAddIngFor({ productId, mode: "picker", qty: "1" });
    setAddCompFor(null);
  }

  function selectIngredient(ing: Ingredient) {
    setAddIngFor((prev) =>
      prev ? { ...prev, mode: "qty", ingredientId: ing.id } : prev
    );
  }

  async function confirmAddIng(product: Product) {
    if (!addIngFor?.ingredientId) return;
    const qty = parseFloat(addIngFor.qty) || 1;
    setBusy(true);
    try {
      await api("/recipes/", {
        method: "POST",
        body: JSON.stringify({ product: product.id, ingredient: addIngFor.ingredientId, quantity_per_unit: qty }),
      });
      await refresh();
      setAddIngFor(null);
    } finally {
      setBusy(false);
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

  // ── component assign ──
  function startAddComp(productId: number) {
    setAddCompFor({ productId, mode: "picker", qty: "1" });
    setAddIngFor(null);
  }

  function selectComponent(comp: Product) {
    setAddCompFor((prev) =>
      prev ? { ...prev, mode: "qty", componentProductId: comp.id } : prev
    );
  }

  async function confirmAddComp(product: Product) {
    if (!addCompFor?.componentProductId) return;
    const qty = parseFloat(addCompFor.qty) || 1;
    setBusy(true);
    try {
      await api("/recipe-product-components/", {
        method: "POST",
        body: JSON.stringify({ product: product.id, component_product: addCompFor.componentProductId, quantity_per_unit: qty }),
      });
      await refresh();
      setAddCompFor(null);
    } finally {
      setBusy(false);
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
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Map recipes</h1>
        <p className="text-xs text-ink-soft">
          Assign ingredients to each menu item. Fine-tune quantities via{" "}
          <span className="font-medium text-ink">set quantities</span>.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {products.map((p) => {
          const isOpen = expandedId === p.id;
          const ingCount = p.recipes.length;
          const compCount = p.product_recipe_components.length;

          const isAddingIng = addIngFor?.productId === p.id;
          const selectedIng = isAddingIng && addIngFor?.ingredientId
            ? ingById.get(addIngFor.ingredientId)
            : undefined;

          const isAddingComp = addCompFor?.productId === p.id;
          const selectedComp = isAddingComp && addCompFor?.componentProductId
            ? products.find((pp) => pp.id === addCompFor.componentProductId)
            : undefined;

          const availableIngs = ingredients.filter(
            (ing) => !p.recipes.some((r) => r.ingredient === ing.id)
          );
          const availableComps = products.filter(
            (pp) => pp.id !== p.id && !p.product_recipe_components.some((c) => c.component_product === pp.id)
          );

          return (
            <div
              key={p.id}
              className="rounded-xl border border-[#d8cdb0] bg-paper overflow-hidden shadow-sm"
            >
              {/* ── Card header (always visible) ── */}
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
                onClick={() => toggleExpand(p.id)}
              >
                <div className="min-w-0">
                  <p className="font-display text-[15px] font-bold text-ink truncate">{p.name}</p>
                  <p className="font-mono text-[10px] text-ink-soft mt-0.5">
                    {ingCount > 0
                      ? `${ingCount} ingredient${ingCount !== 1 ? "s" : ""}`
                      : "No ingredients yet"}
                    {compCount > 0 && ` · ${compCount} derived`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {ingCount === 0 && (
                    <span className="rounded-full bg-chili/10 px-2 py-0.5 font-mono text-[9px] uppercase text-chili">
                      unset
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-ink-soft">
                    {isOpen ? "▴" : "▾"}
                  </span>
                </div>
              </button>

              {/* ── Expanded body ── */}
              {isOpen && (
                <div className="border-t border-[#d8cdb0] px-4 pb-4 pt-3 flex flex-col gap-5">

                  {/* ── Raw ingredients ── */}
                  <section>
                    <div className="flex items-center justify-between mb-2">
                      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                        Ingredients
                      </p>
                      <Link
                        href={`/owner/products/edit-recipe/${p.id}`}
                        className="font-mono text-[10px] text-leaf-deep underline"
                      >
                        set quantities →
                      </Link>
                    </div>

                    {/* Assigned ingredient rows */}
                    {p.recipes.length > 0 && (
                      <div className="mb-3 rounded-lg border border-[#d8cdb0] divide-y divide-dotted divide-[#e8e0cc]">
                        {p.recipes.map((r) => {
                          const ing = ingById.get(r.ingredient);
                          const alias = primaryAlias(ing);
                          return (
                            <div
                              key={r.id}
                              className="flex items-center justify-between px-3 py-2.5 gap-3"
                            >
                              <div className="min-w-0">
                                <p className="font-mono text-[13px] font-medium text-ink truncate">
                                  {displayName(ing, r.ingredient_name)}
                                </p>
                                {alias && (
                                  <p className="font-mono text-[10px] text-ink-soft">{r.ingredient_name}</p>
                                )}
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                <span className="font-mono text-[11px] text-ink-soft">
                                  × {r.quantity_per_unit} {ing?.base_unit ?? ""}
                                </span>
                                <button
                                  type="button"
                                  className="font-mono text-[11px] text-chili opacity-50 hover:opacity-100 transition-opacity"
                                  disabled={busy}
                                  onClick={() => unassign(r)}
                                  title="Remove"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Ingredient picker */}
                    {isAddingIng ? (
                      addIngFor?.mode === "qty" && selectedIng ? (
                        <QtyConfirm
                          label={displayName(selectedIng, selectedIng.name)}
                          subLabel={subName(selectedIng, selectedIng.name)}
                          unit={selectedIng.base_unit}
                          qty={addIngFor.qty}
                          onQtyChange={(v) => setAddIngFor((prev) => prev ? { ...prev, qty: v } : prev)}
                          onConfirm={() => confirmAddIng(p)}
                          onCancel={() => setAddIngFor(null)}
                          busy={busy}
                        />
                      ) : (
                        <IngredientList
                          ingredients={availableIngs}
                          onSelect={selectIngredient}
                          onClose={() => setAddIngFor(null)}
                        />
                      )
                    ) : (
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-lg border border-dashed border-[#d8cdb0] px-3 py-2 font-mono text-[12px] text-ink-soft hover:border-ink hover:text-ink transition-colors w-full"
                        onClick={() => startAddIng(p.id)}
                      >
                        <span className="text-[14px]">+</span> Add ingredient
                      </button>
                    )}
                  </section>

                  {/* ── Derived from menu items ── */}
                  <section>
                    <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                      Derived from menu items
                    </p>
                    <p className="mb-2 text-[10px] text-ink-soft">
                      Preparing this product pulls ready pieces from display stock.
                    </p>

                    {p.product_recipe_components.length > 0 && (
                      <div className="mb-3 rounded-lg border border-[#d8cdb0] divide-y divide-dotted divide-[#e8e0cc]">
                        {p.product_recipe_components.map((c) => (
                          <div
                            key={c.id}
                            className="flex items-center justify-between px-3 py-2.5 gap-3"
                          >
                            <p className="font-mono text-[13px] font-medium text-ink">{c.component_name}</p>
                            <div className="flex shrink-0 items-center gap-3">
                              <span className="font-mono text-[11px] text-ink-soft">
                                × {c.quantity_per_unit} pcs
                              </span>
                              <button
                                type="button"
                                className="font-mono text-[11px] text-chili opacity-50 hover:opacity-100 transition-opacity"
                                disabled={busy}
                                onClick={() => unassignComp(c)}
                                title="Remove"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {isAddingComp ? (
                      addCompFor?.mode === "qty" && selectedComp ? (
                        <QtyConfirm
                          label={selectedComp.name}
                          unit="pcs"
                          qty={addCompFor.qty}
                          onQtyChange={(v) => setAddCompFor((prev) => prev ? { ...prev, qty: v } : prev)}
                          onConfirm={() => confirmAddComp(p)}
                          onCancel={() => setAddCompFor(null)}
                          busy={busy}
                        />
                      ) : (
                        <ProductList
                          products={availableComps}
                          onSelect={selectComponent}
                          onClose={() => setAddCompFor(null)}
                        />
                      )
                    ) : (
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-lg border border-dashed border-[#d8cdb0] px-3 py-2 font-mono text-[12px] text-ink-soft hover:border-ink hover:text-ink transition-colors w-full"
                        onClick={() => startAddComp(p.id)}
                      >
                        <span className="text-[14px]">+</span> Add menu item
                      </button>
                    )}
                  </section>
                </div>
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
