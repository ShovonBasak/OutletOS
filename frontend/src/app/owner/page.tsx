"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Stamp } from "@/components/Stamp";
import { bdt, shortDate, timeOf } from "@/lib/format";
import type { DailyClosing, DashboardSummary, Paginated, StockInRecord } from "@/lib/types";

export default function OwnerDashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [pending, setPending] = useState<StockInRecord[]>([]);
  const [flagged, setFlagged] = useState<DailyClosing[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  async function refresh() {
    const [s, si, cl] = await Promise.all([
      api<DashboardSummary>("/reports/dashboard/?outlet=1"),
      api<Paginated<StockInRecord>>("/stock-in/?status=PENDING"),
      api<Paginated<DailyClosing>>("/daily-closings/?status=SUBMITTED"),
    ]);
    setSummary(s);
    setPending(si.results);
    setFlagged(cl.results);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function act(url: string, id: number) {
    setBusy(id);
    try {
      await api(url, { method: "POST" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  if (!summary) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;
  const p = summary.pnl_today;
  const margin = Number(p.revenue) > 0 ? Math.round((Number(p.net_profit) / Number(p.revenue)) * 100) : 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="kpigrid">
        <div className="kpicard">
          <div className="l">Revenue today</div>
          <div className="n">{bdt(p.revenue)}</div>
          <div className="d pos">net of commission</div>
        </div>
        <div className="kpicard">
          <div className="l">Net profit today</div>
          <div className="n">{bdt(p.net_profit)}</div>
          <div className="d pos">{margin}% margin</div>
        </div>
        <div className="kpicard">
          <div className="l">Pending approvals</div>
          <div className="n">{summary.pending_stock_ins + summary.closings_awaiting_review}</div>
          <div className="d">
            {summary.pending_stock_ins} stock in, {summary.closings_awaiting_review} closing
          </div>
        </div>
        <div className="kpicard">
          <div className="l">Flagged closings</div>
          <div className="n">{flagged.filter((c) => c.has_flag).length}</div>
          <div className="d neg">variance to review</div>
        </div>
      </div>

      <div>
        <h2 className="sec mb-2.5">Needs your review</h2>
        {pending.length === 0 && flagged.length === 0 && (
          <p className="font-mono text-xs text-ink-soft">Nothing waiting. All caught up.</p>
        )}

        {pending.map((r) => (
          <div key={`si-${r.id}`} className="queue-item">
            <div className="qtop">
              <span>Stock in #{r.id}</span>
              <Stamp status="Pending" flat />
            </div>
            <div className="qmeta">
              {r.items.length} line(s) · submitted {timeOf(r.created_at)} by {r.submitted_by_name}
            </div>
            <div className="qbtns">
              <button className="approve" disabled={busy === r.id} onClick={() => act(`/stock-in/${r.id}/approve/`, r.id)}>
                Approve
              </button>
              <button className="reject" disabled={busy === r.id} onClick={() => act(`/stock-in/${r.id}/reject/`, r.id)}>
                Reject
              </button>
            </div>
          </div>
        ))}

        {flagged.map((c) => {
          const fc = c.stock_counts.find((s) => s.flag);
          return (
            <div key={`cl-${c.id}`} className="queue-item">
              <div className="qtop">
                <span>Closing — {shortDate(c.closing_date)}</span>
                <Stamp status="Variance" flat />
              </div>
              <div className="qmeta">
                {fc
                  ? `${fc.product_name}: waste + remains + app sales exceed available (${fc.derived_walkin_sold} pcs)`
                  : `Net ${bdt(c.channel_day_net_revenue)} · by ${c.staff_name}`}
              </div>
              <div className="qbtns">
                <button className="approve" disabled={busy === c.id} onClick={() => act(`/daily-closings/${c.id}/lock/`, c.id)}>
                  Accept
                </button>
                <button className="reject" disabled={busy === c.id}>
                  Flag
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
