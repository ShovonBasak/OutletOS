"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { today } from "@/lib/format";
import type { Paginated, Product } from "@/lib/types";

interface CompRow {
  product: string;
  qty: string;
}

export default function AddComboPage() {
  const router = useRouter();
  const [singles, setSingles] = useState<Product[]>([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [comps, setComps] = useState<CompRow[]>([{ product: "", qty: "1" }]);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Paginated<Product>>("/products/").then((d) => {
      const s = d.results.filter((p) => p.product_type === "SINGLE");
      setSingles(s);
      if (s[0]) setComps([{ product: String(s[0].id), qty: "1" }]);
    });
  }, []);

  function setComp(i: number, patch: Partial<CompRow>) {
    setComps((c) => c.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  async function save() {
    const validComps = comps.filter((c) => c.product && Number(c.qty) > 0);
    if (!name || !price || validComps.length === 0) {
      setError("Name, price and at least one component are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const combo = await api<Product>("/products/", {
        method: "POST",
        body: JSON.stringify({
          name,
          category: "Combo",
          product_type: "COMBO",
          requires_preparation: false,
          selling_price: price,
          effective_from: effectiveFrom,
          is_active: active,
        }),
      });
      await Promise.all(
        validComps.map((c) =>
          api("/combo-components/", {
            method: "POST",
            body: JSON.stringify({
              combo_product: combo.id,
              component_product: Number(c.product),
              quantity_per_combo: Number(c.qty),
            }),
          })
        )
      );
      router.push("/owner/products");
    } catch {
      setError("Could not save combo.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/owner/products" className="self-start font-mono text-[11px] text-ink-soft">
        ‹ Back to Products &amp; packs
      </Link>

      <div className="formgrid">
        <label className="field sm:col-span-2">
          <span className="field-label">Combo name</span>
          <input className="field-input" placeholder="e.g. Family Feast" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Combo price (৳)</span>
          <input className="field-input" placeholder="e.g. 280" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Effective from</span>
          <input className="field-input" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </label>
      </div>

      <h2 className="sec">What&apos;s inside</h2>
      <p className="text-xs text-ink-soft">Selling this combo deducts each component from display stock automatically.</p>
      {comps.map((c, i) => (
        <div key={i} className="comprow max-w-[480px]">
          <select className="field-input flex-[2]" value={c.product} onChange={(e) => setComp(i, { product: e.target.value })}>
            {singles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input className="field-input flex-1" placeholder="Qty" value={c.qty} onChange={(e) => setComp(i, { qty: e.target.value })} />
          <button className="text-chili-deep" onClick={() => setComps((rows) => rows.filter((_, idx) => idx !== i))}>
            ×
          </button>
        </div>
      ))}
      <button
        className="btn btn-ghost w-40"
        onClick={() => setComps((c) => [...c, { product: singles[0] ? String(singles[0].id) : "", qty: "1" }])}
      >
        + Add component
      </button>

      <div className="togglerow mt-2">
        <span className="text-xs">Active</span>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </div>

      {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
      <button className="btn btn-primary w-40" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save combo"}
      </button>
    </div>
  );
}
