"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt } from "@/lib/format";
import { PRODUCT_CATEGORIES } from "@/lib/types";
import type { Paginated, Product } from "@/lib/types";

export default function ProductsPage() {
  const { isAdmin } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [toggling, setToggling] = useState<number | null>(null);
  const [savingCat, setSavingCat] = useState<number | null>(null);
  const [catFlash, setCatFlash] = useState<{ id: number; ok: boolean } | null>(null);

  async function changeCategory(p: Product, newCat: string) {
    setSavingCat(p.id);
    try {
      await api(`/products/${p.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ category: newCat }),
      });
      setProducts((prev) => prev.map((x) => x.id === p.id ? { ...x, category: newCat } : x));
      setCatFlash({ id: p.id, ok: true });
      setTimeout(() => setCatFlash(null), 1500);
    } catch {
      setCatFlash({ id: p.id, ok: false });
      setTimeout(() => setCatFlash(null), 2000);
    } finally {
      setSavingCat(null);
    }
  }

  async function togglePrep(p: Product) {
    setToggling(p.id);
    try {
      await api(`/products/${p.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ requires_preparation: !p.requires_preparation }),
      });
      setProducts((prev) =>
        prev.map((x) => x.id === p.id ? { ...x, requires_preparation: !x.requires_preparation } : x)
      );
    } finally {
      setToggling(null);
    }
  }

  async function setActive(p: Product, active: boolean) {
    setToggling(p.id);
    try {
      await api(`/products/${p.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: active }),
      });
      await loadProducts();
    } finally {
      setToggling(null);
    }
  }

  async function loadProducts() {
    const url = showInactive ? "/products/?include_inactive=1&expand=full" : "/products/?expand=full";
    const d = await api<Paginated<Product>>(url);
    setProducts(d.results);
  }

  useEffect(() => {
    loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInactive]);

  const active = useMemo(() => products.filter((p) => p.is_active), [products]);
  const inactive = useMemo(() => products.filter((p) => !p.is_active), [products]);

  const rows = useMemo(
    () => active.filter((p) => (search ? p.name.toLowerCase().includes(search.toLowerCase()) : true)),
    [active, search]
  );
  const combos = active.filter((p) => p.product_type === "COMBO");

  return (
    <div className="flex flex-col gap-5">
      <div className="filterbar">
        <input placeholder="Search menu items…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button
          onClick={() => setShowInactive((v) => !v)}
          className={`font-mono text-[11px] px-3 py-1.5 rounded border transition-colors ${
            showInactive ? "bg-ink text-paper border-ink" : "border-[#d8cdb0] text-ink-soft hover:border-ink"
          }`}
        >
          {showInactive ? "Hide inactive" : "Show inactive"}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[720px]">
          <thead>
            <tr>
              <th>Product</th>
              <th>Type</th>
              <th>Category</th>
              <th>Selling price</th>
              <th>Stock type</th>
              <th>Recipe (ingredients)</th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="capitalize">{p.product_type.toLowerCase()}</td>
                <td>
                  {isAdmin ? (
                    catFlash?.id === p.id ? (
                      <span className={`font-mono text-[11px] ${catFlash.ok ? "text-leaf-deep" : "text-chili"}`}>
                        {catFlash.ok ? "✓ saved" : "✗ error"}
                      </span>
                    ) : (
                      <select
                        className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-0.5 font-mono text-[11px] text-ink outline-none focus:border-chrome disabled:opacity-40"
                        value={p.category}
                        disabled={savingCat === p.id}
                        onChange={(e) => changeCategory(p, e.target.value)}
                      >
                        {PRODUCT_CATEGORIES.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    )
                  ) : (
                    <span className="font-mono text-[11px] text-ink">{p.category}</span>
                  )}
                </td>
                <td className="font-mono">{bdt(p.selling_price)}</td>
                <td>
                  {p.product_type === "SINGLE" ? (
                    isAdmin ? (
                      <button
                        disabled={toggling === p.id}
                        onClick={() => togglePrep(p)}
                        className={`font-mono text-[10px] px-2 py-0.5 rounded border transition-colors ${
                          p.requires_preparation
                            ? "border-chrome/40 bg-chrome/10 text-chrome"
                            : "border-leaf/40 bg-leaf/10 text-leaf-deep"
                        } disabled:opacity-40`}
                        title="Click to toggle between Prepared and Direct stock"
                      >
                        {p.requires_preparation ? "Prepared" : "Direct stock"}
                      </button>
                    ) : (
                      <span className={`font-mono text-[10px] ${p.requires_preparation ? "text-chrome" : "text-leaf-deep"}`}>
                        {p.requires_preparation ? "Prepared" : "Direct stock"}
                      </span>
                    )
                  ) : (
                    <span className="font-mono text-[10px] text-ink-soft">—</span>
                  )}
                </td>
                <td>
                  {p.product_type === "COMBO"
                    ? "— (components)"
                    : (() => {
                        const rawParts = p.recipes.map((r) => `${r.quantity_per_unit} ${r.base_unit} ${r.ingredient_name}`);
                        const prepParts = p.product_recipe_components.map((c) => `${c.quantity_per_unit} pcs ${c.component_name} (prep)`);
                        const all = [...rawParts, ...prepParts];
                        return all.length ? all.join(", ") : "— no recipe";
                      })()}
                </td>
                {isAdmin && (
                  <td>
                    {p.product_type === "SINGLE" && (
                      <Link
                        href={`/owner/products/edit-recipe/${p.id}`}
                        className="font-mono text-[11px] text-gold-deep underline"
                      >
                        Edit recipe
                      </Link>
                    )}
                  </td>
                )}
                {isAdmin && (
                  <td>
                    <Link
                      href={`/owner/products/edit/${p.id}`}
                      className="font-mono text-[11px] text-ink-soft underline"
                    >
                      Change price
                    </Link>
                  </td>
                )}
                {isAdmin && (
                  <td>
                    <button
                      disabled={toggling === p.id}
                      onClick={() => setActive(p, false)}
                      className="font-mono text-[10px] px-2 py-0.5 rounded border border-chili/40 text-chili hover:bg-chili/10 disabled:opacity-40 transition-colors"
                      title="Deactivate this product"
                    >
                      Deactivate
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="text-ink-soft">
                  No products.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showInactive && inactive.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="sec">Inactive products</h2>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[400px] opacity-60">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Type</th>
                  <th>Category</th>
                  <th>Selling price</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {inactive.map((p) => (
                  <tr key={p.id} className="italic">
                    <td>{p.name}</td>
                    <td className="capitalize">{p.product_type.toLowerCase()}</td>
                    <td>{p.category}</td>
                    <td className="font-mono">{bdt(p.selling_price)}</td>
                    {isAdmin && (
                      <td>
                        <button
                          disabled={toggling === p.id}
                          onClick={() => setActive(p, true)}
                          className="font-mono text-[10px] px-2 py-0.5 rounded border border-leaf/60 text-leaf-deep hover:bg-leaf/10 disabled:opacity-40 transition-colors"
                          title="Reactivate this product"
                        >
                          Reactivate
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-ink-soft">
        Packs &amp; costs live on ingredients now. Set quantities on Edit recipe; assign ingredients in Setup → Map recipes.
      </p>
      {isAdmin && (
        <div className="flex gap-2">
          <Link href="/owner/products/add" className="btn btn-ghost w-40">
            + Add product
          </Link>
          <Link href="/owner/setup/map-recipes" className="btn btn-ghost w-40">
            Map recipes
          </Link>
        </div>
      )}

      <h2 className="sec mt-2">Combo composition</h2>
      <div className="overflow-x-auto">
        <table className="datatable min-w-[480px]">
          <thead>
            <tr>
              <th>Combo</th>
              <th>Contains</th>
            </tr>
          </thead>
          <tbody>
            {combos.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  {c.components.length
                    ? c.components.map((k) => `${k.quantity_per_combo} ${k.component_name}`).join(" + ")
                    : "—"}
                </td>
              </tr>
            ))}
            {combos.length === 0 && (
              <tr>
                <td colSpan={2} className="text-ink-soft">
                  No combos.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-soft">
        Selling a combo deducts each component from display stock automatically.
      </p>
      {isAdmin && (
        <Link href="/owner/products/add-combo" className="btn btn-ghost w-40">
          + Add combo
        </Link>
      )}
    </div>
  );
}
