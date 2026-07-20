"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Stamp } from "@/components/Stamp";
import { shortDate } from "@/lib/format";
import type { Paginated, StockInRecord } from "@/lib/types";

function sourceLabel(r: StockInRecord): string {
  const hasSlip = r.items.some((i) => i.source === "SLIP_EXTRACTED");
  const hasManual = r.items.some((i) => i.source === "MANUAL");
  if (hasSlip && hasManual) return "Slip + manual";
  if (hasSlip) return "Slip";
  return "Manual";
}

export default function StockInApprovals() {
  const [records, setRecords] = useState<StockInRecord[]>([]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  async function refresh() {
    const qs = status ? `?status=${status}` : "";
    const d = await api<Paginated<StockInRecord>>(`/stock-in/${qs}`);
    setRecords(d.results);
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function act(id: number, action: "approve" | "reject") {
    setBusy(id);
    try {
      await api(`/stock-in/${id}/${action}/`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const rows = useMemo(
    () => records.filter((r) => (search ? String(r.id).includes(search.replace(/\D/g, "")) : true)),
    [records, search]
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="filterbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <input placeholder="Search record #" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[640px]">
          <thead>
            <tr>
              <th>Record</th>
              <th>Date</th>
              <th>Confirmed lines</th>
              <th>Source</th>
              <th>Submitted by</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>#SI-{String(r.id).padStart(4, "0")}</td>
                <td>{shortDate(r.stock_in_date)}</td>
                <td>
                  {r.items.length === 0 ? (
                    "—"
                  ) : (
                    <span className="font-mono text-[11px]">
                      {r.items
                        .map(
                          (it) =>
                            `${it.ingredient_name ?? "?"} ${it.confirmed_quantity}${
                              it.unit_captured === "PACK" ? "pk" : it.base_unit ?? ""
                            }`
                        )
                        .join(", ")}
                    </span>
                  )}
                </td>
                <td>{sourceLabel(r)}</td>
                <td>{r.submitted_by_name}</td>
                <td>
                  <Stamp status={r.status} flat />
                </td>
                <td>
                  {r.status === "PENDING" ? (
                    <span className="flex gap-1.5">
                      <button
                        className="rounded-sm bg-leaf px-2 py-1 text-[10px] uppercase text-white disabled:opacity-50"
                        disabled={busy === r.id}
                        onClick={() => act(r.id, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        className="rounded-sm border border-chili px-2 py-1 text-[10px] uppercase text-chili-deep disabled:opacity-50"
                        disabled={busy === r.id}
                        onClick={() => act(r.id, "reject")}
                      >
                        Reject
                      </button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-ink-soft">
                  No records.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
