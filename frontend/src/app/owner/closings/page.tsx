"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Stamp } from "@/components/Stamp";
import { bdt, shortDate } from "@/lib/format";
import type { DailyClosing, Paginated } from "@/lib/types";

function statusLabel(c: DailyClosing): string {
  if (c.status === "LOCKED") return "Locked";
  if (c.has_flag) return "Variance";
  if (c.status === "SUBMITTED") return "In progress";
  return "Draft";
}

function varianceNote(c: DailyClosing): { text: string; flagged: boolean } {
  const fc = c.stock_counts.find((s) => s.flag);
  if (fc) {
    return { text: `${fc.product_name} (${fc.derived_walkin_sold} pcs)`, flagged: true };
  }
  if (c.stock_counts.length > 0) {
    return { text: "OK", flagged: false };
  }
  return { text: "—", flagged: false };
}

export default function ClosingsApprovals() {
  const [closings, setClosings] = useState<DailyClosing[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  async function refresh() {
    const qs = status ? `?status=${status}` : "";
    const d = await api<Paginated<DailyClosing>>(`/daily-closings/${qs}`);
    setClosings(d.results);
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function lock(id: number) {
    setBusy(id);
    try {
      await api(`/daily-closings/${id}/lock/`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const rows = useMemo(() => closings, [closings]);

  return (
    <div className="flex flex-col gap-4">
      <div className="filterbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="LOCKED">Locked</option>
          <option value="SUBMITTED">Variance flagged</option>
          <option value="DRAFT">Draft</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[760px]">
          <thead>
            <tr>
              <th>Date</th>
              <th>Revenue</th>
              <th>Online sell</th>
              <th>Cash+bKash+card</th>
              <th>Stock variance</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const variance = varianceNote(c);
              return (
              <tr key={c.id}>
                <td>{shortDate(c.closing_date)}</td>
                <td>{bdt(c.channel_day_net_revenue)}</td>
                <td>{bdt(c.online_payments)}</td>
                <td>{bdt(c.total_offline_sales)}</td>
                <td className={variance.flagged ? "text-chili-deep font-semibold" : variance.text === "OK" ? "text-leaf-deep" : "text-ink-soft"}>
                  {variance.text}
                </td>
                <td>
                  <Stamp status={statusLabel(c)} flat />
                </td>
                <td>
                  {c.status === "SUBMITTED" ? (
                    <button
                      className="rounded-sm bg-leaf px-2 py-1 text-[10px] uppercase text-white disabled:opacity-50"
                      disabled={busy === c.id}
                      onClick={() => lock(c.id)}
                    >
                      Accept & lock
                    </button>
                  ) : null}
                </td>
              </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-ink-soft">
                  No closings.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
