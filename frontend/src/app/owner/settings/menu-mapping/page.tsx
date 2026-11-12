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
        warnings so you can add them here. A platform item can map to more than one product —
        e.g. a package listed as a single line (&quot;Burger &amp; 2 Chicken Ball&quot;) maps to
        both, each with its own quantity.
      </p>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[600px]">
          <thead>
            <tr>
              <th>Platform name (external)</th>
              <th>Channel</th>
              <th>Maps to</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {maps.map((m) => (
              <tr key={m.id}>
                <td className="font-mono text-xs">{m.external_name}</td>
                <td>{m.channel_name}</td>
                <td>
                  <div className="flex flex-wrap items-center gap-1">
                    {m.items.map((it, i) => (
                      <span key={it.id} className="font-mono text-xs">
                        {i > 0 && <span className="text-ink-soft"> + </span>}
                        <span className="rounded-sm bg-paper-dim px-1.5 py-0.5">
                          {it.quantity}× {it.product_name}
                        </span>
                      </span>
                    ))}
                    {m.items.length === 0 && <span className="text-ink-soft">—</span>}
                  </div>
                </td>
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
                <td colSpan={4} className="text-ink-soft">
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

interface ItemRow {
  product: string;
  quantity: string;
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
  const [items, setItems] = useState<ItemRow[]>([{ product: "", quantity: "1" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!channelId && channels[0]) setChannelId(String(channels[0].id));
    setItems((rows) =>
      rows[0]?.product || !products[0]
        ? rows
        : [{ ...rows[0], product: String(products[0].id) }, ...rows.slice(1)]
    );
  }, [channels, products, channelId]);

  function setItem(i: number, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function addItem() {
    setItems((rows) => [...rows, { product: String(products[0]?.id ?? ""), quantity: "1" }]);
  }

  function removeItem(i: number) {
    setItems((rows) => rows.filter((_, idx) => idx !== i));
  }

  const validItems = items.filter((r) => r.product && Number(r.quantity) > 0);
  const preview = validItems
    .map((r) => `${r.quantity}× ${products.find((p) => String(p.id) === r.product)?.name ?? "?"}`)
    .join(" + ");

  async function save() {
    if (!externalName.trim() || !channelId || validItems.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const m = await api<ChannelMenuMap>("/channel-menu-maps/", {
        method: "POST",
        body: JSON.stringify({
          channel: Number(channelId),
          external_name: externalName.trim(),
          is_active: true,
        }),
      });
      const createdItems = await Promise.all(
        validItems.map((r) =>
          api<ChannelMenuMap["items"][number]>("/channel-menu-map-items/", {
            method: "POST",
            body: JSON.stringify({
              menu_map: m.id,
              product: Number(r.product),
              quantity: Number(r.quantity),
            }),
          })
        )
      );
      onSaved({ ...m, items: createdItems });
      setExternalName("");
      setItems([{ product: String(products[0]?.id ?? ""), quantity: "1" }]);
    } catch (e: unknown) {
      const body = (e as { body?: { external_name?: string[] } })?.body;
      setError(body?.external_name?.[0] ?? "Failed to save mapping.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-[#d8cdb0] bg-paper p-3 flex flex-col gap-3">
      <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Add mapping</p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="field col-span-2">
          <span className="field-label">Platform name (exact)</span>
          <input
            className="field-input font-mono text-xs"
            placeholder="e.g. Burger & 2 Chicken Ball"
            value={externalName}
            onChange={(e) => setExternalName(e.target.value)}
          />
        </label>
        <label className="field col-span-2">
          <span className="field-label">Channel</span>
          <select className="field-input" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {channels.filter((c) => c.is_active).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="field-label">Maps to (one or more internal products)</span>
        {items.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <select
              className="field-input flex-1"
              value={row.product}
              onChange={(e) => setItem(i, { product: e.target.value })}
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <span className="font-mono text-xs text-ink-soft">×</span>
            <input
              className="field-input w-16 text-center font-mono text-sm"
              inputMode="numeric"
              value={row.quantity}
              onChange={(e) => setItem(i, { quantity: e.target.value })}
            />
            <button
              type="button"
              className="shrink-0 rounded-sm px-2 py-1 font-mono text-xs text-chili disabled:opacity-30"
              onClick={() => removeItem(i)}
              disabled={items.length === 1}
              aria-label="Remove product"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="self-start rounded-sm bg-paper-dim px-2 py-1 font-mono text-[10px] text-ink-soft hover:bg-paper-dim/70"
          onClick={addItem}
        >
          + Add another product
        </button>
      </div>

      {preview && (
        <p className="font-mono text-[10px] text-ink-soft">
          Will map &quot;{externalName.trim() || "…"}&quot; → {preview}
        </p>
      )}

      {error && <p className="font-mono text-[10px] text-chili">{error}</p>}
      <button
        className="btn btn-primary w-32 self-start"
        disabled={saving || !externalName.trim() || validItems.length === 0}
        onClick={save}
      >
        {saving ? "Saving…" : "Add mapping"}
      </button>
    </div>
  );
}
