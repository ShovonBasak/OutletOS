"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Paginated, SalesChannel } from "@/lib/types";

export default function SalesChannelsPage() {
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [recomputingId, setRecomputingId] = useState<number | null>(null);
  const [recomputedMsg, setRecomputedMsg] = useState<Record<number, string>>({});

  useEffect(() => {
    api<Paginated<SalesChannel>>("/sales-channels/").then((d) => setChannels(d.results));
  }, []);

  function patch(id: number, update: Partial<SalesChannel>) {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, ...update } : c)));
  }

  async function save(c: SalesChannel) {
    setSavingId(c.id);
    try {
      await api(`/sales-channels/${c.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          commission_rate: c.commission_rate,
          settlement_type: c.settlement_type,
        }),
      });
    } finally {
      setSavingId(null);
    }
  }

  async function recompute(c: SalesChannel) {
    setRecomputingId(c.id);
    setRecomputedMsg((m) => ({ ...m, [c.id]: "" }));
    try {
      const res = await api<{ recomputed: number }>(
        `/sales-channels/${c.id}/recompute-commissions/`,
        { method: "POST" }
      );
      setRecomputedMsg((m) => ({
        ...m,
        [c.id]: `${res.recomputed} line${res.recomputed !== 1 ? "s" : ""} updated`,
      }));
    } finally {
      setRecomputingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-soft">
        Commission rate and settlement type for each channel. All channels are manual entry in v1 —
        Foodpanda &amp; Foodi partner APIs require account-manager approval.
      </p>
      <div className="overflow-x-auto">
        <table className="datatable min-w-[640px]">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Commission %</th>
              <th>Settlement</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  <input
                    className="w-20 rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 text-center font-mono text-[11px]"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={parseFloat((Number(c.commission_rate) * 100).toFixed(4))}
                    onChange={(e) =>
                      patch(c.id, { commission_rate: (Number(e.target.value) / 100).toFixed(4) })
                    }
                  />
                </td>
                <td>
                  <select
                    className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 font-mono text-[11px]"
                    value={c.settlement_type}
                    onChange={(e) =>
                      patch(c.id, {
                        settlement_type: e.target.value as SalesChannel["settlement_type"],
                      })
                    }
                  >
                    <option value="DIRECT_TO_ACCOUNT">Direct to account</option>
                    <option value="COLLECTED_AT_OUTLET">Collected at outlet</option>
                  </select>
                </td>
                <td>
                  <button
                    className="rounded-sm bg-action px-2 py-1 text-[10px] uppercase text-gold disabled:opacity-50"
                    disabled={savingId === c.id}
                    onClick={() => save(c)}
                  >
                    {savingId === c.id ? "…" : "Save"}
                  </button>
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-sm border border-[#d8cdb0] px-2 py-1 font-mono text-[10px] text-ink-soft hover:border-ink-soft disabled:opacity-40"
                      disabled={recomputingId === c.id || Number(c.commission_rate) === 0}
                      title="Recompute commission on all existing sales lines for this channel"
                      onClick={() => recompute(c)}
                    >
                      {recomputingId === c.id ? "…" : "Recompute history"}
                    </button>
                    {recomputedMsg[c.id] && (
                      <span className="font-mono text-[10px] text-leaf-deep">
                        ✓ {recomputedMsg[c.id]}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {channels.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-soft">
                  No channels configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-soft">
        Use <strong>Recompute history</strong> after changing a commission rate to backfill
        commission_amount and net_amount on all existing sales lines for that channel.
      </p>
    </div>
  );
}
