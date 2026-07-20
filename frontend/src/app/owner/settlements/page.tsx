"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Stamp } from "@/components/Stamp";
import { bdt } from "@/lib/format";

interface SettlementRow {
  id: number;
  channel: string;
  period_start: string;
  period_end: string;
  expected_amount: string;
  received_amount: string | null;
  variance: string;
  status: string;
}

const STATUS_STAMP: Record<string, string> = {
  RECEIVED: "Received",
  PENDING: "Pending",
  PARTIAL: "Variance",
  DISPUTED: "Variance",
};

export default function SettlementsPage() {
  const [rows, setRows] = useState<SettlementRow[]>([]);

  useEffect(() => {
    api<SettlementRow[]>("/reports/settlements/?outlet=1").then(setRows).catch(() => setRows([]));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[640px] text-xs text-ink-soft">
        Only channels set to &quot;Direct to account&quot; in Settings appear here — Foodpanda by default. Foodi, Pathao &amp;
        Walk-in are collected same-day and don&apos;t need settlement tracking.
      </p>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[560px]">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Period</th>
              <th>Expected</th>
              <th>Received</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.channel}</td>
                <td>
                  {s.period_start} → {s.period_end}
                </td>
                <td>{bdt(s.expected_amount)}</td>
                <td>{s.received_amount ? bdt(s.received_amount) : "—"}</td>
                <td>
                  <Stamp status={STATUS_STAMP[s.status] ?? s.status} flat />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-soft">
                  No settlements recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
