"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate, today } from "@/lib/format";
import { Stamp } from "@/components/Stamp";
import type { DailyClosing, Paginated } from "@/lib/types";

const PAGE_SIZE = 10;

interface ChannelSummaryItem {
  channel_id: number;
  channel_name: string;
  total_quantity: number;
  total_gross: string;
  total_discount: string;
  total_net: string;
}

function nDaysAgo(from: string, n: number): string {
  const [y, m, d] = from.split("-").map(Number);
  const date = new Date(y, m - 1, d - n);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function ClosingHistory() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;

  const todayStr = today();
  const [dateFrom, setDateFrom] = useState(() => nDaysAgo(todayStr, 30));
  const [dateTo, setDateTo] = useState(todayStr);
  const [page, setPage] = useState(1);
  const [closings, setClosings] = useState<DailyClosing[]>([]);
  const [count, setCount] = useState(0);
  const [channelSummary, setChannelSummary] = useState<ChannelSummaryItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const prevCtx = useRef({ outlet: 0, dateFrom: "", dateTo: "", page: 0 });

  useEffect(() => {
    if (!user) return;
    const ctx = { outlet, dateFrom, dateTo, page };
    const p = prevCtx.current;
    if (
      p.outlet === ctx.outlet &&
      p.dateFrom === ctx.dateFrom &&
      p.dateTo === ctx.dateTo &&
      p.page === ctx.page
    ) return;
    const filterChanged =
      p.outlet !== ctx.outlet || p.dateFrom !== ctx.dateFrom || p.dateTo !== ctx.dateTo;
    prevCtx.current = ctx;

    setLoaded(false);
    const rangeParams = `outlet=${outlet}&date_from=${dateFrom}&date_to=${dateTo}`;

    const listCall = api<Paginated<DailyClosing>>(
      `/daily-closings/?${rangeParams}&page=${page}&page_size=${PAGE_SIZE}`
    );
    const summaryCall = filterChanged
      ? api<ChannelSummaryItem[]>(`/daily-closings/channel-summary/?${rangeParams}`)
      : Promise.resolve(null);

    Promise.allSettled([listCall, summaryCall]).then(([listRes, summaryRes]) => {
      if (listRes.status === "fulfilled") {
        setClosings(listRes.value.results);
        setCount(listRes.value.count);
      }
      if (summaryRes.status === "fulfilled" && summaryRes.value !== null) {
        setChannelSummary(summaryRes.value);
      }
      setLoaded(true);
    });
  }, [user, outlet, dateFrom, dateTo, page]);

  const totalPages = Math.ceil(count / PAGE_SIZE);
  const totalNet = channelSummary.reduce((sum, c) => sum + Number(c.total_net), 0);

  function applyFilter(from: string, to: string) {
    setDateFrom(from);
    setDateTo(to);
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/staff/closing" className="font-mono text-sm text-ink-soft">‹</Link>
        <div>
          <h1 className="font-display text-xl font-bold">Closing history</h1>
          <p className="text-xs text-ink-soft">
            {count > 0 ? `${count} closing${count === 1 ? "" : "s"} · tap to view` : "Tap a date to view details"}
          </p>
        </div>
      </div>

      {/* Date range filter */}
      <div className="rounded border border-[#d8cdb0] bg-[#fffdf7] p-3">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-ink-soft">Date range</p>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="mb-1 block font-mono text-[10px] text-ink-soft">From</label>
            <input
              type="date"
              value={dateFrom}
              max={dateTo}
              onChange={(e) => applyFilter(e.target.value, dateTo)}
              className="w-full rounded border border-[#d8cdb0] bg-white px-2 py-1.5 font-mono text-xs text-ink"
            />
          </div>
          <div className="flex-1">
            <label className="mb-1 block font-mono text-[10px] text-ink-soft">To</label>
            <input
              type="date"
              value={dateTo}
              min={dateFrom}
              max={todayStr}
              onChange={(e) => applyFilter(dateFrom, e.target.value)}
              className="w-full rounded border border-[#d8cdb0] bg-white px-2 py-1.5 font-mono text-xs text-ink"
            />
          </div>
        </div>
      </div>

      {/* Channel summary card */}
      {channelSummary.length > 0 && (
        <div className="rounded border border-[#d8cdb0] bg-[#fffdf7]">
          <div className="border-b border-[#d8cdb0] px-4 py-2.5">
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Sales by channel</p>
          </div>
          <div className="divide-y divide-[#e8e0c8]">
            {channelSummary.map((ch) => (
              <div key={ch.channel_id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="font-display text-sm font-semibold">{ch.channel_name}</p>
                  <p className="font-mono text-[10px] text-ink-soft">{ch.total_quantity} sold</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-bold text-leaf-deep">{bdt(ch.total_net)}</p>
                  {Number(ch.total_discount) > 0 && (
                    <p className="font-mono text-[10px] text-ink-soft">
                      –{bdt(ch.total_discount)} disc
                    </p>
                  )}
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between bg-[#f0ead8] px-4 py-2.5">
              <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-ink">Total</p>
              <p className="font-mono text-sm font-bold text-ink">{bdt(String(totalNet))}</p>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {!loaded && (
        <p className="font-mono text-xs text-ink-soft">Loading…</p>
      )}
      {loaded && closings.length === 0 && (
        <p className="font-mono text-xs text-ink-soft">No closings in this date range.</p>
      )}

      <div className="flex flex-col gap-2">
        {closings.map((c) => (
          <Link
            key={c.id}
            href={`/staff/closing/history/${c.closing_date}`}
            className="flex items-center justify-between rounded border border-[#d8cdb0] bg-[#fffdf7] px-4 py-3"
          >
            <div>
              <p className="font-display text-sm font-bold">
                {shortDate(c.closing_date)}
                {c.has_flag && (
                  <span className="ml-2 font-mono text-[9px] text-chili">⚠ variance</span>
                )}
              </p>
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-[#d8cdb0] pt-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="font-mono text-xs text-ink-soft disabled:opacity-30"
          >
            ‹ Prev
          </button>
          <p className="font-mono text-[10px] text-ink-soft">
            Page {page} of {totalPages}
          </p>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="font-mono text-xs text-ink-soft disabled:opacity-30"
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
