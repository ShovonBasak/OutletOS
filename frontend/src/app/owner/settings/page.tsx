"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { bdt } from "@/lib/format";
import type {
  ChannelPrice,
  ChannelPromotion,
  CostCategory,
  OrderLevelOffer,
  Paginated,
  Product,
  SalesChannel,
} from "@/lib/types";

export default function SettingsPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [prices, setPrices] = useState<ChannelPrice[]>([]);
  const [promos, setPromos] = useState<ChannelPromotion[]>([]);
  const [offers, setOffers] = useState<OrderLevelOffer[]>([]);
  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [savingId, setSavingId] = useState<number | null>(null);

  useEffect(() => {
    api<Paginated<SalesChannel>>("/sales-channels/").then((d) => setChannels(d.results));
    api<Paginated<ChannelPrice>>("/channel-prices/").then((d) => setPrices(d.results)).catch(() => {});
    api<Paginated<ChannelPromotion>>("/channel-promotions/").then((d) => setPromos(d.results)).catch(() => {});
    api<Paginated<OrderLevelOffer>>("/order-level-offers/").then((d) => setOffers(d.results)).catch(() => {});
    api<Paginated<CostCategory>>("/cost-categories/").then((d) => setCategories(d.results)).catch(() => {});
    api<Paginated<Product>>("/products/").then((d) => setProducts(d.results)).catch(() => {});
  }, []);

  const channelName = (id: number | null) => (id == null ? "All channels" : channels.find((c) => c.id === id)?.name ?? "—");
  const productName = (id: number | null) => (id == null ? "All items" : products.find((p) => p.id === id)?.name ?? "—");

  function patchChannel(id: number, patch: Partial<SalesChannel>) {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  async function saveChannel(c: SalesChannel) {
    setSavingId(c.id);
    try {
      await api(`/sales-channels/${c.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ commission_rate: c.commission_rate, settlement_type: c.settlement_type }),
      });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-[680px] text-xs text-ink-soft">
        All channels are manual entry in v1 — Foodpanda &amp; Foodi partner APIs need account-manager approval, revisited
        once the manual flow is proven.
      </p>

      {/* Sales channels */}
      <section className="flex flex-col gap-2">
        <h2 className="sec">Sales channels</h2>
        <p className="text-xs text-ink-soft">Commission and settlement type are both editable — nothing is hardcoded.</p>
        <div className="overflow-x-auto">
          <table className="datatable min-w-[560px]">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Commission %</th>
                <th>Settlement</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <input
                      className="w-14 rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 text-center font-mono text-[11px]"
                      value={(Number(c.commission_rate) * 100).toFixed(0)}
                      onChange={(e) => patchChannel(c.id, { commission_rate: String(Number(e.target.value) / 100) })}
                    />
                  </td>
                  <td>
                    <select
                      className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 font-mono text-[11px]"
                      value={c.settlement_type}
                      onChange={(e) => patchChannel(c.id, { settlement_type: e.target.value as SalesChannel["settlement_type"] })}
                    >
                      <option value="DIRECT_TO_ACCOUNT">Direct to account</option>
                      <option value="COLLECTED_AT_OUTLET">Collected at outlet</option>
                    </select>
                  </td>
                  <td>
                    <button
                      className="rounded-sm bg-action px-2 py-1 text-[10px] uppercase text-gold disabled:opacity-50"
                      disabled={savingId === c.id}
                      onClick={() => saveChannel(c)}
                    >
                      {savingId === c.id ? "…" : "Save"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Channel-specific pricing */}
      <section className="flex flex-col gap-2">
        <h2 className="sec">Channel-specific pricing</h2>
        <p className="text-xs text-ink-soft">Direct price per product/combo per channel — this is how combo deals get set up. Tap a row to edit.</p>
        <div className="overflow-x-auto">
          <table className="datatable min-w-[560px]">
            <thead>
              <tr>
                <th>Product / Combo</th>
                <th>Channel</th>
                <th>Price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer hover:bg-paper-dim"
                  onClick={() => router.push(`/owner/settings/channel-price?id=${p.id}`)}
                >
                  <td>{p.product_name}</td>
                  <td>{p.channel_name}</td>
                  <td>{bdt(p.price)}</td>
                  <td>{p.is_active ? "Active" : "Inactive"}</td>
                </tr>
              ))}
              {prices.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-ink-soft">
                    No channel prices.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Link href="/owner/settings/channel-price" className="btn btn-ghost w-44">
          + Add channel price
        </Link>
      </section>

      {/* Ongoing promotions */}
      <section className="flex flex-col gap-2">
        <h2 className="sec">Ongoing promotions</h2>
        <p className="text-xs text-ink-soft">Simple % or fixed discounts off the base price — not for combos.</p>
        <div className="overflow-x-auto">
          <table className="datatable min-w-[560px]">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Product</th>
                <th>Discount</th>
                <th>Dates</th>
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <tr key={p.id}>
                  <td>{channelName(p.channel)}</td>
                  <td>{productName(p.product)}</td>
                  <td>
                    {p.discount_type === "PERCENTAGE" ? `${Number(p.value)}% off` : `${bdt(p.value)} off`}
                  </td>
                  <td>
                    {p.effective_from}
                    {p.effective_to ? ` → ${p.effective_to}` : " → ongoing"}
                  </td>
                </tr>
              ))}
              {promos.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-ink-soft">
                    No promotions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Order-level offers */}
      <section className="flex flex-col gap-2">
        <h2 className="sec flex items-center gap-2">
          Order-level offers
          <span className="rounded border border-chili-deep px-1.5 py-0.5 font-mono text-[9px] uppercase text-chili-deep">
            Reference only
          </span>
        </h2>
        <p className="max-w-[680px] text-xs text-ink-soft">
          Threshold deals can&apos;t be calculated line-by-line — this system tracks daily quantities, not individual orders.
          Logged for reference; reconcile via the channel&apos;s settlement total.
        </p>
        <div className="overflow-x-auto">
          <table className="datatable min-w-[560px]">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Offer</th>
                <th>Dates</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.id}>
                  <td>{channelName(o.channel)}</td>
                  <td>{o.description}</td>
                  <td>
                    {o.effective_from}
                    {o.effective_to ? ` → ${o.effective_to}` : " → ongoing"}
                  </td>
                </tr>
              ))}
              {offers.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-ink-soft">
                    No offers logged.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Cost categories */}
      <section className="flex flex-col gap-2">
        <h2 className="sec">Cost categories</h2>
        <div className="overflow-x-auto">
          <table className="datatable min-w-[360px]">
            <thead>
              <tr>
                <th>Category</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="capitalize">{c.cost_type.toLowerCase()}</td>
                </tr>
              ))}
              {categories.length === 0 && (
                <tr>
                  <td colSpan={2} className="text-ink-soft">
                    No categories.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
