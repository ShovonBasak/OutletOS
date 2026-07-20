"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { Product } from "@/lib/types";

const CATEGORIES = ["Sandwich", "Fried chicken", "Sides", "Drinks", "Sauces", "Other"];

export default function AddProductPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [price, setPrice] = useState("");
  const [prepared, setPrepared] = useState(true);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name || !price) {
      setError("Name and selling price are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const product = await api<Product>("/products/", {
        method: "POST",
        body: JSON.stringify({
          name,
          category,
          product_type: "SINGLE",
          requires_preparation: prepared,
          selling_price: price,
          is_active: active,
        }),
      });
      // Recipe (which ingredients it's made from) is assigned next.
      router.push(`/owner/products/edit-recipe/${product.id}`);
    } catch {
      setError("Could not save product.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/owner/products" className="self-start font-mono text-[11px] text-ink-soft">
        ‹ Back to Products &amp; recipes
      </Link>

      <div className="formgrid">
        <label className="field sm:col-span-2">
          <span className="field-label">Product name</span>
          <input className="field-input" placeholder="e.g. Chicken Popcorn" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Category</span>
          <select className="field-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Selling price — walk-in (৳)</span>
          <input className="field-input" placeholder="e.g. 95" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
      </div>

      <div className="field max-w-[480px]">
        <span className="field-label">How is it made available for sale?</span>
        <div className="segmented max-w-[340px]">
          <button className={prepared ? "active" : ""} onClick={() => setPrepared(true)}>
            Prepared item
          </button>
          <button className={!prepared ? "active" : ""} onClick={() => setPrepared(false)}>
            Direct stock
          </button>
        </div>
        <p className="mt-1.5 text-xs text-ink-soft">
          &quot;Prepared&quot; = fried/cooked from packs (uses the prep log). &quot;Direct stock&quot; = sold straight from
          stock, e.g. cold drinks.
        </p>
      </div>

      <p className="max-w-[480px] text-xs text-ink-soft">
        Packs &amp; costs now live on ingredients. After saving, you&apos;ll set which ingredients
        this product uses (its recipe) on the next screen.
      </p>

      <div className="togglerow">
        <span className="text-xs">Active</span>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </div>

      {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
      <button className="btn btn-primary w-40" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save product"}
      </button>
    </div>
  );
}
