"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { today } from "@/lib/format";
import type { ChannelPrice, Paginated, Product, SalesChannel } from "@/lib/types";

function ChannelPriceForm() {
  const router = useRouter();
  const params = useSearchParams();
  const editId = params.get("id");

  const [products, setProducts] = useState<Product[]>([]);
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [product, setProduct] = useState("");
  const [channel, setChannel] = useState("");
  const [price, setPrice] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Paginated<Product>>("/products/").then((d) => {
      setProducts(d.results);
      if (!editId && d.results[0]) setProduct((prev) => prev || String(d.results[0].id));
    });
    api<Paginated<SalesChannel>>("/sales-channels/").then((d) => {
      setChannels(d.results);
      if (!editId && d.results[0]) setChannel((prev) => prev || String(d.results[0].id));
    });
  }, [editId]);

  useEffect(() => {
    if (!editId) return;
    api<ChannelPrice>(`/channel-prices/${editId}/`).then((p) => {
      setProduct(String(p.product));
      setChannel(String(p.channel));
      setPrice(p.price);
      setFrom(p.effective_from);
      setTo(p.effective_to ?? "");
      setActive(p.is_active);
    });
  }, [editId]);

  async function save() {
    if (!product || !channel || !price) {
      setError("Product, channel and price are required.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = JSON.stringify({
      product: Number(product),
      channel: Number(channel),
      price,
      effective_from: from,
      effective_to: to || null,
      is_active: active,
    });
    try {
      if (editId) {
        await api(`/channel-prices/${editId}/`, { method: "PATCH", body });
      } else {
        await api("/channel-prices/", { method: "POST", body });
      }
      router.push("/owner/settings");
    } catch {
      setError("Could not save price.");
      setSaving(false);
    }
  }

  async function remove() {
    if (!editId) return;
    setSaving(true);
    try {
      await api(`/channel-prices/${editId}/`, { method: "DELETE" });
      router.push("/owner/settings");
    } catch {
      setError("Could not remove price.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/owner/settings" className="self-start font-mono text-[11px] text-ink-soft">
        ‹ Back to Settings
      </Link>

      <div className="formgrid">
        <label className="field">
          <span className="field-label">Product / Combo</span>
          <select className="field-input" value={product} onChange={(e) => setProduct(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Channel</span>
          <select className="field-input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Price (৳)</span>
          <input className="field-input" placeholder="e.g. 249" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Effective from</span>
          <input type="date" className="field-input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Effective to (optional)</span>
          <input type="date" className="field-input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      <div className="togglerow">
        <span className="text-xs">Active</span>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </div>

      {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
      <div className="flex gap-2.5">
        <button className="btn btn-primary w-40" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save price"}
        </button>
        {editId && (
          <button className="btn btn-reject w-36" disabled={saving} onClick={remove}>
            Remove price
          </button>
        )}
      </div>
    </div>
  );
}

export default function ChannelPricePage() {
  return (
    <Suspense fallback={<p className="font-mono text-xs text-ink-soft">Loading…</p>}>
      <ChannelPriceForm />
    </Suspense>
  );
}
