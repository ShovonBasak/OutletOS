"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate } from "@/lib/format";
import { Stamp } from "@/components/Stamp";
import type { DailyClosing, Paginated } from "@/lib/types";

export default function ClosingHistory() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const [closings, setClosings] = useState<DailyClosing[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<Paginated<DailyClosing>>(`/daily-closings/?outlet=${outlet}`)
      .then((d) => {
        const sorted = [...d.results].sort(
          (a, b) => b.closing_date.localeCompare(a.closing_date)
        );
        setClosings(sorted);
      })
      .finally(() => setLoaded(true));
  }, [outlet]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/staff" className="font-mono text-sm text-ink-soft">‹</Link>
        <div>
          <h1 className="font-display text-xl font-bold">Closing history</h1>
          <p className="text-xs text-ink-soft">Tap a date to view details</p>
        </div>
      </div>

      {loaded && closings.length === 0 && (
        <p className="font-mono text-xs text-ink-soft">No closings recorded yet.</p>
      )}

      <div className="flex flex-col gap-2">
        {closings.map((c) => (
          <Link
            key={c.id}
            href={`/staff/closing/history/${c.closing_date}`}
            className="flex items-center justify-between rounded border border-[#d8cdb0] bg-[#fffdf7] px-4 py-3"
          >
            <div>
              <p className="font-display text-sm font-bold">{shortDate(c.closing_date)}</p>
              <p className="font-mono text-[11px] text-ink-soft">
                Net {bdt(c.channel_day_net_revenue)} · Cash {bdt(c.computed_cash)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Stamp status={c.status} />
              <span className="font-mono text-ink-soft">›</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
