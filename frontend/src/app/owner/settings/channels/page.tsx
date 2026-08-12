"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Paginated, SalesChannel } from "@/lib/types";

export default function SalesChannelsPage() {
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [savingId, setSavingId] = useState<number | null>(null);

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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-soft">
        Commission rate and settlement type for each channel. All channels are manual entry in v1 —
        Foodpanda &amp; Foodi partner APIs require account-manager approval.
      </p>
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
                    onChange={(e) =>
                      patch(c.id, { commission_rate: String(Number(e.target.value) / 100) })
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
              </tr>
            ))}
            {channels.length === 0 && (
              <tr>
                <td colSpan={4} className="text-ink-soft">
                  No channels configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
