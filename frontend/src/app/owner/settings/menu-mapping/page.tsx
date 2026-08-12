"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ChannelMenuMap, Paginated, Product, SalesChannel } from "@/lib/types";

export default function MenuMappingPage() {
  const [maps, setMaps] = useState<ChannelMenuMap[]>([]);
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    api<Paginated<SalesChannel>>("/sales-channels/").then((d) => setChannels(d.results));
    api<Paginated<Product>>("/products/").then((d) => setProducts(d.results)).catch(() => {});
    api<Paginated<ChannelMenuMap>>("/channel-menu-maps/").then((d) => setMaps(d.results)).catch(() => {});
  }, []);

  async function remove(id: number) {
    await api(`/channel-menu-maps/${id}/`, { method: "DELETE" });
    setMaps((ms) => ms.filter((m) => m.id !== id));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-soft">
        Maps Foodpanda (and other platform) item names to internal products. When staff uploads a
        platform order report, matched names auto-populate quantities. Unmatched names appear as
        warnings so you can add them here.
      </p>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[600px]">
          <thead>
            <tr>
              <th>Platform name (external)</th>
              <th>Channel</th>
              <th>Maps to</th>
              <th>Qty ×</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {maps.map((m) => (
              <tr key={m.id}>
                <td className="font-mono text-xs">{m.external_name}</td>
                <td>{m.channel_name}</td>
                <td>{m.product_name}</td>
                <td className="text-center font-mono">{m.quantity_multiplier}</td>
                <td>
                  <button
                    className="rounded-sm bg-paper-dim px-2 py-1 font-mono text-[10px] text-chili hover:bg-chili/10"
                    onClick={() => remove(m.id)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {maps.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-soft">
                  No mappings yet. Add one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <MenuMapForm
        channels={channels}
        products={products}
        onSaved={(m) => setMaps((ms) => [...ms, m])}
      />
    </div>
  );
}

function MenuMapForm({
  channels,
  products,
  onSaved,
}: {
  channels: SalesChannel[];
  products: Product[];
  onSaved: (m: ChannelMenuMap) => void;
}) {
  const [channelId, setChannelId] = useState("");
  const [externalName, setExternalName] = useState("");
  const [productId, setProductId] = useState("");
  const [multiplier, setMultiplier] = useState("1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!channelId && channels[0]) setChannelId(String(channels[0].id));
    if (!productId && products[0]) setProductId(String(products[0].id));
  }, [channels, products, channelId, productId]);

  async function save() {
    if (!externalName.trim() || !channelId || !productId) return;
    setSaving(true);
    setError(null);
    try {
      const m = await api<ChannelMenuMap>("/channel-menu-maps/", {
        method: "POST",
        body: JSON.stringify({
          channel: Number(channelId),
          external_name: externalName.trim(),
          product: Number(productId),
          quantity_multiplier: Number(multiplier) || 1,
          is_active: true,
        }),
      });
      onSaved(m);
      setExternalName("");
      setMultiplier("1");
    } catch (e: unknown) {
      const body = (e as { body?: { external_name?: string[] } })?.body;
      setError(body?.external_name?.[0] ?? "Failed to save mapping.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-[#d8cdb0] bg-paper p-3 flex flex-col gap-2">
      <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Add mapping</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="field col-span-2">
          <span className="field-label">Platform name (exact)</span>
          <input
            className="field-input font-mono text-xs"
            placeholder="e.g. 3X Hot &amp; Crispy Chicken"
            value={externalName}
            onChange={(e) => setExternalName(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Channel</span>
          <select className="field-input" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {channels.filter((c) => c.is_active).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Qty multiplier</span>
          <input
            className="field-input font-mono text-sm"
            inputMode="numeric"
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
          />
        </label>
        <label className="field col-span-2">
          <span className="field-label">Maps to (internal product)</span>
          <select className="field-input" value={productId} onChange={(e) => setProductId(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="font-mono text-[10px] text-chili">{error}</p>}
      <button
        className="btn btn-primary w-32 self-start"
        disabled={saving || !externalName.trim()}
        onClick={save}
      >
        {saving ? "Saving…" : "Add mapping"}
      </button>
    </div>
  );
}
