"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import type { Paginated } from "@/lib/types";

interface OilChange {
  id: number;
  pan_number: 1 | 2;
  changed_at: string;
  logged_by: number;
  logged_by_name: string;
  notes: string;
  created_at: string;
}

function daysSince(dateStr: string): number {
  const changed = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  changed.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - changed.getTime()) / 86_400_000);
}

export default function FryerOilHistoryPage() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const [records, setRecords] = useState<OilChange[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Paginated<OilChange>>(`/fryer-oil-changes/?outlet=${outlet}`)
      .then((res) => setRecords(res.results))
      .finally(() => setLoading(false));
  }, [outlet]);

  const lastPan1 = records.find((r) => r.pan_number === 1);
  const lastPan2 = records.find((r) => r.pan_number === 2);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-xl font-bold">Fryer oil changes</h1>
        <p className="font-mono text-[11px] text-ink-soft">Full history of oil replacements by pan</p>
      </div>

      {/* Last change per pan */}
      <div className="grid grid-cols-2 gap-3">
        {([lastPan1, lastPan2] as const).map((last, i) => {
          const panNo = i + 1;
          const days = last ? daysSince(last.changed_at) : null;
          const stale = days !== null && days > 3;
          return (
            <div key={panNo} className="ticket flex flex-col gap-1">
              <p className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Pan {panNo}</p>
              {last ? (
                <>
                  <p className={`font-mono text-lg font-bold ${stale ? "text-chili" : "text-leaf-deep"}`}>
                    {days === 0 ? "Today" : days === 1 ? "1 day ago" : `${days} days ago`}
                  </p>
                  <p className="font-mono text-[10px] text-ink-soft">{shortDate(last.changed_at)}</p>
                </>
              ) : (
                <p className="font-mono text-sm text-ink-soft/40 italic">No record</p>
              )}
            </div>
          );
        })}
      </div>

      {loading && <p className="font-mono text-xs text-ink-soft">Loading…</p>}

      {/* Full history */}
      {!loading && records.length === 0 && (
        <p className="font-mono text-xs text-ink-soft">No oil changes recorded yet.</p>
      )}

      {records.length > 0 && (
        <div className="rounded border border-[#d8cdb0] bg-paper overflow-hidden">
          <div className="grid grid-cols-[4rem_1fr_1fr_auto] gap-x-3 px-3 py-2 bg-[#f5f0e8] border-b border-dashed border-[#d8cdb0]">
            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Pan</span>
            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Date</span>
            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Logged by</span>
            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Notes</span>
          </div>
          <div className="divide-y divide-dashed divide-[#e8dfc8]">
            {records.map((r) => (
              <div key={r.id} className="grid grid-cols-[4rem_1fr_1fr_auto] gap-x-3 px-3 py-2.5 items-start">
                <span className="font-mono text-sm font-bold text-ink">Pan {r.pan_number}</span>
                <span className="font-mono text-[11px] text-ink">{shortDate(r.changed_at)}</span>
                <span className="font-mono text-[11px] text-ink-soft">{r.logged_by_name}</span>
                <span className="font-mono text-[11px] text-ink-soft/60 max-w-[10rem] text-right">
                  {r.notes || "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
