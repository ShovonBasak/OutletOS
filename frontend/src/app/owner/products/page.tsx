"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { bdt } from "@/lib/format";
import type { Paginated, Product } from "@/lib/types";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<Paginated<Product>>("/products/").then((d) => setProducts(d.results));
  }, []);

  const rows = useMemo(
    () => products.filter((p) => (search ? p.name.toLowerCase().includes(search.toLowerCase()) : true)),
    [products, search]
  );
  const combos = products.filter((p) => p.product_type === "COMBO");

  return (
    <div className="flex flex-col gap-5">
      <div className="filterbar">
        <input placeholder="Search menu items…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[680px]">
          <thead>
            <tr>
              <th>Product</th>
              <th>Type</th>
              <th>Category</th>
              <th>Selling price</th>
              <th>Recipe (ingredients)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="capitalize">{p.product_type.toLowerCase()}</td>
                <td>{p.category}</td>
                <td>{bdt(p.selling_price)}</td>
                <td>
                  {p.product_type === "COMBO"
                    ? "— (components)"
                    : p.recipes.length
                    ? p.recipes
                        .map((r) => `${r.quantity_per_unit} ${r.base_unit} ${r.ingredient_name}`)
                        .join(", ")
                    : "— no recipe"}
                </td>
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
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-ink-soft">
                  No products.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-soft">
        Packs &amp; costs live on ingredients now. Set quantities on Edit recipe; assign ingredients in Setup → Map recipes.
      </p>
      <div className="flex gap-2">
        <Link href="/owner/products/add" className="btn btn-ghost w-40">
          + Add product
        </Link>
        <Link href="/owner/setup/map-recipes" className="btn btn-ghost w-40">
          Map recipes
        </Link>
      </div>

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
      <Link href="/owner/products/add-combo" className="btn btn-ghost w-40">
        + Add combo
      </Link>
    </div>
  );
}
