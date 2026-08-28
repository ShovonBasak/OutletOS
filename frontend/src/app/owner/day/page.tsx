"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { pushPermissionState, subscribeToPush } from "@/lib/push";
import { bdt, bdtD, shortDate, today, timeOf } from "@/lib/format";
import type { DayOverview, DayOverviewStockIn, DayOverviewSalesProduct } from "@/lib/types";
import { INGREDIENT_GROUPS } from "@/lib/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function packLabel(qty: number, ppp: string | null): string | null {
  const perPack = ppp ? parseFloat(ppp) : 0;
  if (perPack <= 0 || qty <= 0) return null;
  const packs = Math.floor(qty / perPack);
  if (packs === 0) return null;
  const extra = parseFloat((qty % perPack).toFixed(3));
  if (extra < 0.001) return `${packs} pk`;
  return `${packs} pk + ${extra % 1 === 0 ? extra : extra.toFixed(1)}`;
}

function localIso(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prevDay(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return localIso(d);
}

function nextDay(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return localIso(d);
}

const DAY_STATUS_CONFIG = {
  NOT_STARTED: {
    label: "Not started",
    dot: "bg-ink-soft/40",
    badge: "bg-ink-soft/10 text-ink-soft border-ink-soft/20",
  },
  STOCK_CONFIRMED: {
    label: "Stock confirmed",
    dot: "bg-gold animate-pulse",
    badge: "bg-gold/10 text-gold-deep border-gold/30",
  },
  IN_PROGRESS: {
    label: "In progress",
    dot: "bg-chrome animate-pulse",
    badge: "bg-chrome/10 text-chrome border-chrome/30",
  },
  CLOSED: {
    label: "Closed",
    dot: "bg-leaf",
    badge: "bg-leaf/10 text-leaf-deep border-leaf/30",
  },
} as const;

const STOCK_IN_STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-ink-soft/10 text-ink-soft",
  PENDING: "bg-gold/15 text-gold-deep",
  APPROVED: "bg-leaf/15 text-leaf-deep",
  REJECTED: "bg-chili/10 text-chili",
};

// ── sub-components ────────────────────────────────────────────────────────────

function Section({
  title,
  badge,
  badgeColor = "bg-ink-soft/10 text-ink-soft",
  defaultOpen = false,
  children,
}: {
  title: string;
  badge: string;
  badgeColor?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-[#d8cdb0] bg-paper overflow-hidden">
      <button
        className="flex w-full items-center justify-between px-4 py-3.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-mono text-[12px] font-semibold text-ink tracking-wide">
          {title}
        </span>
        <span className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${badgeColor}`}>
            {badge}
          </span>
          <span className="font-mono text-[11px] text-ink-soft">{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-dashed border-[#d8cdb0] px-4 pb-4 pt-3">
          {children}
        </div>
      )}
    </div>
  );
}

function KpiPill({
  label,
  value,
  color = "text-ink",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex flex-1 flex-col rounded-lg border border-[#d8cdb0] bg-paper px-3 py-2.5">
      <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">{label}</span>
      <span className={`font-mono text-[15px] font-bold leading-tight ${color}`}>{value}</span>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function OwnerHome() {
  const [date, setDate] = useState(today());
  const [data, setData] = useState<DayOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notifState, setNotifState] = useState<"default" | "granted" | "denied" | "busy">(
    "default"
  );

  useEffect(() => {
    setNotifState(pushPermissionState() as typeof notifState);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setData(null);
    try {
      const d = await api<DayOverview>(`/reports/day-overview/?outlet=1&date=${date}`);
      setData(d);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  async function actStockIn(id: number, action: "approve" | "reject") {
    setActionBusy(`si-${id}`);
    try {
      await api(`/stock-in/${id}/${action}/`, { method: "POST" });
      await load();
    } finally {
      setActionBusy(null);
    }
  }

  async function lockClosing(id: number) {
    setActionBusy(`cl-${id}`);
    try {
      await api(`/daily-closings/${id}/lock/`, { method: "POST" });
      await load();
    } finally {
      setActionBusy(null);
    }
  }

  async function enableNotifications() {
    setNotifState("busy");
    try {
      const ok = await subscribeToPush();
      setNotifState(ok ? "granted" : "denied");
    } catch {
      setNotifState("denied");
    }
  }

  const isToday = date === today();
  const opDay = data?.operating_day;
  const statusCfg = opDay
    ? DAY_STATUS_CONFIG[opDay.status]
    : DAY_STATUS_CONFIG.NOT_STARTED;

  const pendingStockIns = (data?.stock_ins ?? []).filter((s) => s.status === "PENDING");
  const closingNeedsReview =
    data?.closing && data.closing.status === "SUBMITTED";
  const hasActions = pendingStockIns.length > 0 || closingNeedsReview;

  const discrepancies = (data?.day_start_checks ?? []).filter(
    (c) => Number(c.discrepancy_qty) !== 0
  );
  const totalShrinkage = discrepancies
    .filter((c) => Number(c.discrepancy_qty) > 0)
    .reduce((s, c) => s + Number(c.shrinkage_cost), 0);

  const totalPiecesPrepared = (data?.prep_logs ?? []).reduce(
    (s, p) => s + p.pieces_prepared,
    0
  );
  const totalPrepValue = (data?.prep_logs ?? []).reduce(
    (s, p) => s + p.pieces_prepared * Number(p.selling_price),
    0
  );

  return (
    <div className="flex flex-col gap-4">

      {/* ── Push notification prompt ────────────────────────────────────── */}
      {notifState === "default" && (
        <div className="flex items-center justify-between rounded-lg border border-gold/30 bg-gold/5 px-3 py-2.5">
          <p className="font-mono text-[11px] text-ink-soft">
            Enable alerts for stock-in submissions
          </p>
          <button
            onClick={enableNotifications}
            className="ml-3 shrink-0 rounded bg-near-black px-3 py-1.5 font-mono text-[11px] font-semibold text-gold"
          >
            Enable
          </button>
        </div>
      )}

      {/* ── Date navigator ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setDate(prevDay(date))}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[#d8cdb0] font-mono text-sm text-ink-soft active:bg-paper-dim"
        >
          ‹
        </button>
        <div className="text-center">
          <p className="font-display text-[15px] font-bold text-ink">
            {isToday ? "Today" : shortDate(date)}
          </p>
          <p className="font-mono text-[10px] text-ink-soft">{date}</p>
        </div>
        <button
          onClick={() => setDate(nextDay(date))}
          disabled={isToday}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[#d8cdb0] font-mono text-sm text-ink-soft disabled:opacity-30 active:bg-paper-dim"
        >
          ›
        </button>
      </div>

      {loading && (
        <p className="py-6 text-center font-mono text-xs text-ink-soft">Loading…</p>
      )}

      {data && (
        <>
          {/* ── Status + Financial KPIs — combined hero ──────────────────── */}
          <div className="rounded-xl border border-[#d8cdb0] bg-paper px-4 pt-3.5 pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${statusCfg.dot}`} />
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                  Operating day
                </span>
              </div>
              <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium ${statusCfg.badge}`}>
                {opDay ? statusCfg.label : "Not started"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-x-3 border-t border-dashed border-[#d8cdb0] pt-3">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Revenue</span>
                <span className={`font-mono text-[16px] font-bold leading-tight ${Number(data.pnl.revenue) > 0 ? "text-leaf-deep" : "text-ink"}`}>
                  {bdt(data.pnl.revenue)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Net profit</span>
                <span className={`font-mono text-[16px] font-bold leading-tight ${
                  Number(data.pnl.net_profit) > 0 ? "text-leaf-deep"
                  : Number(data.pnl.net_profit) < 0 ? "text-chili"
                  : "text-ink"
                }`}>
                  {bdt(data.pnl.net_profit)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">COGS</span>
                <span className="font-mono text-[15px] font-semibold leading-tight text-ink-soft">
                  {bdt(data.pnl.cogs)}
                </span>
              </div>
            </div>
          </div>

          {/* ── Action queue ─────────────────────────────────────────────── */}
          {hasActions && (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-chili">
                ● Needs your review
              </p>

              {pendingStockIns.map((r) => (
                <StockInActionCard
                  key={r.id}
                  record={r}
                  busy={actionBusy}
                  onApprove={() => actStockIn(r.id, "approve")}
                  onReject={() => actStockIn(r.id, "reject")}
                />
              ))}

              {closingNeedsReview && data.closing && (
                <div className="queue-item">
                  <div className="qtop">
                    <span>Closing — {shortDate(date)}</span>
                    <span
                      className={`stamp ${data.closing.has_flag ? "stamp-variance" : "stamp-pending"} rotate-0`}
                    >
                      {data.closing.has_flag ? "Variance" : "Pending lock"}
                    </span>
                  </div>
                  <div className="qmeta">
                    {data.closing.has_flag
                      ? `${data.closing.flagged_products.length} flagged product(s) · walk-in derived below zero`
                      : `Revenue ${bdt(data.closing.channel_day_net_revenue)} — awaiting owner lock`}
                  </div>
                  <div className="qbtns">
                    <button
                      className="approve"
                      disabled={actionBusy === `cl-${data.closing.id}`}
                      onClick={() => lockClosing(data.closing!.id)}
                    >
                      {actionBusy === `cl-${data.closing.id}` ? "…" : "Accept & lock"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Business sections: Sales + Closing ───────────────────────── */}
          <div className="flex flex-col gap-2">

            {/* Closing */}
            <Section
              title="Closing"
              badge={
                data.closing
                  ? data.closing.status === "LOCKED"
                    ? `Locked · ${bdt(data.closing.channel_day_net_revenue)}`
                    : data.closing.status === "SUBMITTED"
                    ? `Awaiting review · ${bdt(data.closing.channel_day_net_revenue)}`
                    : "Draft"
                  : "Not closed"
              }
              badgeColor={
                data.closing?.status === "LOCKED"
                  ? "bg-leaf/10 text-leaf-deep border border-leaf/20"
                  : data.closing?.status === "SUBMITTED"
                  ? "bg-gold/15 text-gold-deep border border-gold/20"
                  : "bg-ink-soft/10 text-ink-soft"
              }
              defaultOpen={!!(data.closing && data.closing.status !== "DRAFT")}
            >
              {!data.closing ? (
                <p className="font-mono text-[11px] text-ink-soft italic">No closing for this day.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {/* Revenue summary */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="flex flex-col">
                      <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Total revenue</span>
                      <span className="font-mono text-[14px] font-bold text-leaf-deep">
                        {bdt(data.closing.channel_day_net_revenue)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Online</span>
                      <span className="font-mono text-[13px] font-semibold text-ink">
                        {bdt(data.closing.online_payments)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Cash</span>
                      <span className="font-mono text-[13px] font-semibold text-ink">
                        {bdt(data.closing.computed_cash)}
                      </span>
                    </div>
                  </div>

                  {/* Payment entries */}
                  {data.closing.payments.length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      <p className="font-mono text-[9px] uppercase tracking-wide text-ink-soft mb-0.5">
                        Payments
                      </p>
                      {data.closing.payments.map((p, i) => (
                        <div key={i} className="flex justify-between">
                          <span className="font-mono text-[11px] text-ink-soft">
                            {p.is_primary_cash ? "Cash (computed)" : p.account_name}
                          </span>
                          <span className="font-mono text-[11px] font-semibold text-ink">
                            {bdt(p.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Remains at close */}
                  {data.closing.stock_counts_remains.length > 0 && (() => {
                    const remains = data.closing!.stock_counts_remains;
                    const categories = [...new Set(remains.map(r => r.product_category))];
                    return (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-baseline justify-between mb-0.5">
                          <p className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">
                            Unsold prep at close
                          </p>
                          <span className="font-mono text-[11px] font-bold text-gold-deep">
                            {bdt(data.closing!.total_remains_value)}
                          </span>
                        </div>
                        {categories.map(cat => (
                          <div key={cat}>
                            <p className="font-mono text-[9px] text-ink-soft/40 uppercase tracking-wider pt-1 pb-0.5">
                              {cat}
                            </p>
                            {remains.filter(r => r.product_category === cat).map((r, i) => (
                              <div key={i} className="flex items-baseline justify-between">
                                <span className="font-mono text-[11px] text-ink truncate mr-2">
                                  {r.product_name}
                                </span>
                                <span className="font-mono text-[11px] shrink-0 text-ink-soft">
                                  {r.remains_pieces} pcs
                                  <span className="text-ink-soft/40 mx-1">·</span>
                                  <span className="text-gold-deep font-semibold">{bdt(r.remains_value)}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Flags */}
                  {data.closing.has_flag && (
                    <div className="rounded border border-chili/30 bg-chili/5 px-3 py-2">
                      <p className="font-mono text-[10px] font-semibold text-chili mb-1">
                        ⚠ Stock count flags
                      </p>
                      {data.closing.flagged_products.map((fp, i) => (
                        <p key={i} className="font-mono text-[10px] text-chili">
                          {fp.product_name}: walk-in derived {fp.derived_walkin_sold} pcs
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Section>

            {/* Sales */}
            {(() => {
              const sales: DayOverviewSalesProduct[] = data.closing?.sales_by_product ?? [];
              const categories = [...new Set(sales.map(s => s.product_category))];
              const totalRevenue = sales.reduce((sum, s) => sum + Number(s.revenue), 0);
              const totalPcs = sales.reduce((sum, s) => sum + s.total_sold, 0);
              return (
                <Section
                  title="Sales"
                  badge={
                    sales.length === 0
                      ? data.closing ? "No sales" : "Not closed"
                      : `${totalPcs} pcs · ${bdt(totalRevenue)}`
                  }
                  badgeColor={
                    sales.length > 0
                      ? "bg-leaf/10 text-leaf-deep border border-leaf/20"
                      : "bg-ink-soft/10 text-ink-soft"
                  }
                  defaultOpen={false}
                >
                  {sales.length === 0 ? (
                    <p className="font-mono text-[11px] text-ink-soft italic">
                      {data.closing ? "No product sales recorded." : "Day not closed yet."}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-0 -mx-1">
                      {categories.map(cat => {
                        const catRows = sales.filter(s => s.product_category === cat);
                        return (
                          <div key={cat}>
                            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/40 px-1 pt-2 pb-0.5">
                              {cat}
                            </p>
                            <div className="grid grid-cols-[minmax(0,1fr)_2.5rem_2.5rem_3rem_6rem] px-1 pb-1">
                              <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Product</span>
                              <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">WI</span>
                              <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">App</span>
                              <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Total</span>
                              <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Revenue</span>
                            </div>
                            {catRows.map((s, i) => (
                              <div
                                key={i}
                                className="grid grid-cols-[minmax(0,1fr)_2.5rem_2.5rem_3rem_6rem] rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]"
                              >
                                <div className="min-w-0">
                                  <p className="font-mono text-[11px] text-ink truncate">{s.product_name}</p>
                                  {Number(s.selling_price) > 0 && (
                                    <p className="font-mono text-[9px] text-ink-soft/60">{bdtD(s.selling_price)} / pc</p>
                                  )}
                                </div>
                                <span className="self-center font-mono text-[11px] text-ink-soft text-right">
                                  {s.walkin_sold > 0 ? s.walkin_sold : "—"}
                                </span>
                                <span className="self-center font-mono text-[11px] text-ink-soft text-right">
                                  {s.online_sold > 0 ? s.online_sold : "—"}
                                </span>
                                <span className="self-center font-mono text-[12px] font-bold text-ink text-right">
                                  {s.total_sold}
                                </span>
                                <span className="self-center font-mono text-[11px] text-leaf-deep font-semibold text-right">
                                  {Number(s.revenue) > 0 ? bdtD(s.revenue) : "—"}
                                </span>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                      <div className="mt-2 flex items-center justify-between border-t border-dashed border-[#d8cdb0] pt-2 px-1">
                        <span className="font-mono text-[10px] text-ink-soft">{totalPcs} pcs total</span>
                        <span className="font-mono text-[12px] font-bold text-leaf-deep">
                          {bdt(totalRevenue)}
                        </span>
                      </div>
                    </div>
                  )}
                </Section>
              );
            })()}

          </div>

          {/* ── Operational detail ────────────────────────────────────────── */}
          <div className="flex items-center gap-3 py-1">
            <div className="h-px flex-1 bg-[#d8cdb0]" />
            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/40">
              Operational detail
            </span>
            <div className="h-px flex-1 bg-[#d8cdb0]" />
          </div>

          <div className="flex flex-col gap-2">

            {/* Prepared for sale */}
            {(() => {
              type ProdSummary = {
                product_name: string;
                selling_price: string;
                fresh: number;
                carried_forward: number;
                wastage: number;
              };
              const byProduct = data.prep_logs.reduce<Record<string, ProdSummary>>((acc, p) => {
                if (!acc[p.product_name]) {
                  acc[p.product_name] = {
                    product_name: p.product_name,
                    selling_price: p.selling_price,
                    fresh: 0,
                    carried_forward: 0,
                    wastage: 0,
                  };
                }
                if (p.source === "FRESH") acc[p.product_name].fresh += p.pieces_prepared;
                else acc[p.product_name].carried_forward += p.pieces_prepared;
                acc[p.product_name].wastage += p.wastage_pieces ?? 0;
                return acc;
              }, {});
              for (const w of data.closing?.stock_counts_wastage ?? []) {
                if (byProduct[w.product_name]) {
                  byProduct[w.product_name].wastage += w.wastage_pieces;
                }
              }
              const rows = Object.values(byProduct);
              const grandTotal = rows.reduce(
                (s, r) => s + (r.fresh + r.carried_forward) * Number(r.selling_price),
                0
              );
              return (
                <Section
                  title="Prepared for sale"
                  badge={
                    rows.length === 0
                      ? "Nothing prepared"
                      : `${rows.length} product${rows.length !== 1 ? "s" : ""}`
                  }
                  badgeColor={rows.length > 0 ? "bg-chrome/10 text-chrome border border-chrome/20" : "bg-ink-soft/10 text-ink-soft"}
                  defaultOpen={false}
                >
                  {rows.length === 0 ? (
                    <p className="font-mono text-[11px] text-ink-soft italic">No preparation entries for this day.</p>
                  ) : (
                    <div className="flex flex-col gap-0 -mx-1">
                      <div className="grid grid-cols-[minmax(0,1fr)_3rem_2.5rem_2.5rem_6rem] px-1 pb-1">
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Product</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Fr</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">CF</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Wst</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Sell value</span>
                      </div>
                      {rows.map((r, i) => {
                        const total = r.fresh + r.carried_forward;
                        const sellValue = total * Number(r.selling_price);
                        return (
                          <div
                            key={i}
                            className="grid grid-cols-[minmax(0,1fr)_3rem_2.5rem_2.5rem_6rem] rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]"
                          >
                            <div className="min-w-0">
                              <p className="font-mono text-[11px] text-ink truncate">{r.product_name}</p>
                              {Number(r.selling_price) > 0 && (
                                <p className="font-mono text-[9px] text-ink-soft/60">{bdtD(r.selling_price)} / pc</p>
                              )}
                            </div>
                            <span className="self-center font-mono text-[11px] font-semibold text-chrome text-right">
                              {r.fresh > 0 ? r.fresh : "—"}
                            </span>
                            <span className="self-center font-mono text-[11px] text-gold-deep text-right">
                              {r.carried_forward > 0 ? r.carried_forward : "—"}
                            </span>
                            <span className={`self-center font-mono text-[11px] text-right ${r.wastage > 0 ? "text-chili font-semibold" : "text-ink-soft"}`}>
                              {r.wastage > 0 ? r.wastage : "—"}
                            </span>
                            <span className="self-center font-mono text-[11px] text-ink-soft text-right">
                              {sellValue > 0 ? bdtD(sellValue) : "—"}
                            </span>
                          </div>
                        );
                      })}
                      {grandTotal > 0 && (
                        <div className="mt-2 flex justify-end border-t border-dashed border-[#d8cdb0] pt-2 px-1">
                          <span className="font-mono text-[11px] font-semibold text-ink">
                            Total: {bdtD(grandTotal)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </Section>
              );
            })()}

            {/* Preparation log */}
            <Section
              title="Preparation log"
              badge={
                data.prep_logs.length === 0
                  ? "Nothing prepared"
                  : `${totalPiecesPrepared} pcs · ${data.prep_logs.length} entr${data.prep_logs.length !== 1 ? "ies" : "y"}`
              }
              badgeColor={
                data.prep_logs.length > 0
                  ? "bg-chrome/10 text-chrome border border-chrome/20"
                  : "bg-ink-soft/10 text-ink-soft"
              }
              defaultOpen={false}
            >
              {data.prep_logs.length === 0 ? (
                <p className="font-mono text-[11px] text-ink-soft italic">
                  {opDay ? "No prep entries yet." : "Day not started yet."}
                </p>
              ) : (
                <div className="flex flex-col gap-0">
                  <div className="grid grid-cols-[minmax(0,1fr)_2.5rem_3rem_6.5rem] pb-1">
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Product</span>
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Src</span>
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Pcs</span>
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Value</span>
                  </div>
                  {data.prep_logs.map((p, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[minmax(0,1fr)_2.5rem_3rem_6.5rem] border-t border-dashed border-[#e8dfc8] py-1.5"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-[11px] text-ink truncate">{p.product_name}</p>
                        <p className="font-mono text-[9px] text-ink-soft/60">{timeOf(p.timestamp)}</p>
                      </div>
                      <span
                        className={`mt-0.5 self-start font-mono text-[10px] text-right ${
                          p.source === "FRESH" ? "text-chrome" : "text-gold-deep"
                        }`}
                      >
                        {p.source === "FRESH" ? "Fr" : "CF"}
                      </span>
                      <span className="mt-0.5 self-start font-mono text-[11px] font-semibold text-ink text-right">
                        {p.pieces_prepared}
                      </span>
                      <span className="mt-0.5 self-start font-mono text-[11px] text-ink-soft text-right">
                        {Number(p.selling_price) > 0
                          ? bdtD(p.pieces_prepared * Number(p.selling_price))
                          : "—"}
                      </span>
                    </div>
                  ))}
                  {totalPrepValue > 0 && (
                    <div className="mt-2 flex justify-end border-t border-dashed border-[#d8cdb0] pt-2">
                      <span className="font-mono text-[11px] text-ink font-semibold">
                        Total: {bdtD(totalPrepValue)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </Section>

            {/* Stock in */}
            <Section
              title="Stock in"
              badge={
                data.stock_ins.length === 0
                  ? "None today"
                  : `${data.stock_ins.length} record${data.stock_ins.length !== 1 ? "s" : ""}`
              }
              badgeColor={
                pendingStockIns.length > 0
                  ? "bg-gold/15 text-gold-deep border border-gold/20"
                  : "bg-ink-soft/10 text-ink-soft"
              }
              defaultOpen={pendingStockIns.length > 0}
            >
              {data.stock_ins.length === 0 ? (
                <p className="font-mono text-[11px] text-ink-soft italic">No stock received today.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {data.stock_ins.map((r) => (
                    <Link
                      key={r.id}
                      href="/owner/stock-in"
                      className="flex items-start justify-between rounded border border-[#e8dfc8] bg-paper-dim px-3 py-2 active:bg-paper-dim/70"
                    >
                      <div>
                        <p className="font-mono text-[11px] font-semibold text-ink">
                          #{String(r.id).padStart(4, "0")}
                          {r.invoice_number ? ` · ${r.invoice_number}` : ""}
                        </p>
                        <p className="font-mono text-[10px] text-ink-soft">
                          {r.item_count} line{r.item_count !== 1 ? "s" : ""} · by {r.submitted_by_name}
                        </p>
                        {r.notes && (
                          <p className="font-mono text-[10px] text-ink-soft italic">{r.notes}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${
                            STOCK_IN_STATUS_BADGE[r.status] ?? "bg-ink-soft/10 text-ink-soft"
                          }`}
                        >
                          {r.status}
                        </span>
                        <span className="font-mono text-[11px] text-ink-soft">›</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Section>

            {/* Day-start stock check */}
            <Section
              title="Day-start stock check"
              badge={
                discrepancies.length > 0
                  ? `${discrepancies.length} discrepanc${discrepancies.length === 1 ? "y" : "ies"}`
                  : opDay
                  ? "All clear"
                  : "No data"
              }
              badgeColor={
                discrepancies.length > 0
                  ? "bg-chili/10 text-chili border border-chili/20"
                  : "bg-leaf/10 text-leaf-deep"
              }
              defaultOpen={discrepancies.length > 0}
            >
              {data.day_start_checks.length === 0 ? (
                <p className="font-mono text-[11px] text-ink-soft italic">
                  {opDay ? "No stock checks recorded." : "Day not started yet."}
                </p>
              ) : (
                <div className="flex flex-col gap-0 -mx-1">
                  {(() => {
                    const COL = "grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-3";
                    const knownGroups = new Set(INGREDIENT_GROUPS.map(g => g.key));
                    const grouped = [...INGREDIENT_GROUPS, { key: "Other", icon: "🗂" }].flatMap(({ key, icon }) => {
                      const rows = data.day_start_checks.filter(c => c.ingredient_group === key);
                      if (rows.length === 0) return [];
                      return [
                        <div key={`grp-${key}`} className="px-1 pt-2 pb-0.5">
                          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50">
                            {icon} {key}
                          </span>
                        </div>,
                        <div key={`hdr-${key}`} className={`${COL} px-1 pb-1`}>
                          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Ingredient</span>
                          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">System</span>
                          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Confirmed</span>
                          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Δ</span>
                        </div>,
                        ...rows.map((chk, i) => {
                          const disc = Number(chk.discrepancy_qty);
                          const sysQty = Number(chk.system_qty);
                          const confQty = Number(chk.confirmed_qty);
                          const isShortfall = disc > 0;
                          const isSurplus = disc < 0;
                          const sysPacks = packLabel(sysQty, chk.pieces_per_pack);
                          const confPacks = packLabel(confQty, chk.pieces_per_pack);
                          return (
                            <div
                              key={`${key}-${i}`}
                              className={`${COL} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8] ${
                                isShortfall ? "bg-chili/5" : isSurplus ? "bg-gold/5" : ""
                              }`}
                            >
                              <span className="font-mono text-[11px] text-ink truncate">{chk.ingredient}</span>
                              <div className="text-right">
                                <p className="font-mono text-[11px] text-ink-soft">
                                  {sysQty.toFixed(1)} {chk.base_unit}
                                </p>
                                {sysPacks && <p className="font-mono text-[9px] text-ink-soft/50">{sysPacks}</p>}
                              </div>
                              <div className="text-right">
                                <p className="font-mono text-[11px] text-ink">{confQty.toFixed(1)}</p>
                                {confPacks && <p className="font-mono text-[9px] text-ink-soft/50">{confPacks}</p>}
                              </div>
                              <span
                                className={`font-mono text-[11px] font-semibold text-right self-start mt-0.5 ${
                                  isShortfall ? "text-chili" : isSurplus ? "text-gold-deep" : "text-ink-soft"
                                }`}
                              >
                                {disc === 0 ? "—" : disc > 0 ? `−${disc.toFixed(1)}` : `+${Math.abs(disc).toFixed(1)}`}
                              </span>
                              {(isShortfall || isSurplus) && (
                                <div className="col-span-4 pl-0 pb-0.5">
                                  <span className="font-mono text-[10px] text-ink-soft capitalize">
                                    {chk.discrepancy_reason
                                      ? chk.discrepancy_reason.toLowerCase().replace(/_/g, " ")
                                      : "no reason given"}
                                    {chk.note ? ` · ${chk.note}` : ""}
                                    {isShortfall && Number(chk.shrinkage_cost) > 0 && (
                                      <span className="text-chili"> · shrinkage {bdt(chk.shrinkage_cost)}</span>
                                    )}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        }),
                      ];
                    });
                    const ungrouped = data.day_start_checks.filter(c => !knownGroups.has(c.ingredient_group) && c.ingredient_group !== "Other");
                    return [...grouped, ...ungrouped.map((chk, i) => {
                      const disc = Number(chk.discrepancy_qty);
                      const isShortfall = disc > 0;
                      const isSurplus = disc < 0;
                      return (
                        <div key={`ung-${i}`} className={`${COL} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8] ${isShortfall ? "bg-chili/5" : isSurplus ? "bg-gold/5" : ""}`}>
                          <span className="font-mono text-[11px] text-ink truncate">{chk.ingredient}</span>
                          <span className="font-mono text-[11px] text-ink-soft text-right">{Number(chk.system_qty).toFixed(1)} {chk.base_unit}</span>
                          <span className="font-mono text-[11px] text-ink text-right">{Number(chk.confirmed_qty).toFixed(1)}</span>
                          <span className={`font-mono text-[11px] font-semibold text-right ${isShortfall ? "text-chili" : isSurplus ? "text-gold-deep" : "text-ink-soft"}`}>
                            {disc === 0 ? "—" : disc > 0 ? `−${disc.toFixed(1)}` : `+${Math.abs(disc).toFixed(1)}`}
                          </span>
                        </div>
                      );
                    })];
                  })()}
                  {totalShrinkage > 0 && (
                    <div className="mt-2 flex justify-end border-t border-dashed border-[#d8cdb0] pt-2 px-1">
                      <span className="font-mono text-[11px] text-chili font-semibold">
                        Total shrinkage cost: {bdt(totalShrinkage)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </Section>

            {/* Day end / Current stock */}
            {(() => {
              const beverages = data.display_stock.filter(
                s => !s.requires_preparation && s.product_category === "Beverages" && s.pieces_available > 0
              );
              const otherReady = data.display_stock.filter(
                s => !s.requires_preparation && s.product_category !== "Beverages" && s.pieces_available > 0
              );
              const rawStock = data.raw_stock ?? [];
              const totalItems = beverages.length + otherReady.length + rawStock.length;

              const bevTotal = beverages.reduce((sum, s) => sum + s.pieces_available * Number(s.purchase_price ?? 0), 0);
              const otherReadyTotal = otherReady.reduce((sum, s) => sum + s.pieces_available * Number(s.purchase_price ?? 0), 0);
              const rawTotal = rawStock.reduce((sum, rs) => sum + Number(rs.quantity_available) * Number(rs.cost_per_base_unit), 0);

              const COL4 = "grid grid-cols-[minmax(0,1fr)_3rem_6rem_6.5rem]";
              const sectionTitle = opDay?.status === "CLOSED" ? "Day end stock" : "Current stock";

              return (
                <Section
                  title={sectionTitle}
                  badge={totalItems === 0 ? "Empty" : `${totalItems} item${totalItems !== 1 ? "s" : ""}`}
                  badgeColor="bg-ink-soft/10 text-ink-soft"
                  defaultOpen={false}
                >
                  {totalItems === 0 ? (
                    <p className="font-mono text-[11px] text-ink-soft italic">No stock data available.</p>
                  ) : (
                    <div className="flex flex-col gap-0 -mx-1">

                      {/* ── Beverages ── */}
                      {beverages.length > 0 && (
                        <>
                          <div className="px-1 pb-0.5 pt-1">
                            <span className="font-mono text-[9px] uppercase tracking-widest text-gold-deep">Beverages</span>
                          </div>
                          <div className={`${COL4} px-1 pb-1 pt-1`}>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Item</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Pcs</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Cost/pc</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Value</span>
                          </div>
                          {beverages.map((s, i) => {
                            const cost = Number(s.purchase_price ?? 0);
                            const pks = packLabel(s.pieces_available, s.pieces_per_pack);
                            return (
                              <div key={`bev-${i}`} className={`${COL4} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]`}>
                                <span className="font-mono text-[11px] text-ink truncate">{s.product_name}</span>
                                <div className="text-right">
                                  <p className={`font-mono text-[11px] font-semibold ${s.pieces_available < 5 ? "text-chili" : "text-ink"}`}>{s.pieces_available}</p>
                                  {pks && <p className="font-mono text-[9px] text-ink-soft/50">{pks}</p>}
                                </div>
                                <span className="font-mono text-[10px] text-ink-soft text-right self-start mt-0.5">{cost > 0 ? bdtD(cost) : "—"}</span>
                                <span className="font-mono text-[11px] text-ink-soft text-right self-start mt-0.5">{cost > 0 ? bdtD(s.pieces_available * cost) : "—"}</span>
                              </div>
                            );
                          })}
                          {bevTotal > 0 && (
                            <div className="flex justify-end pt-1.5 px-1">
                              <span className="font-mono text-[10px] text-gold-deep font-semibold">Subtotal: {bdtD(bevTotal)}</span>
                            </div>
                          )}
                        </>
                      )}

                      {/* ── Other ready to sell + Raw ingredients ── */}
                      {(otherReady.length > 0 || rawStock.length > 0) && (
                        <>
                          <div className={`px-1 pb-0.5 ${beverages.length > 0 ? "pt-3" : "pt-1"}`}>
                            <span className="font-mono text-[9px] uppercase tracking-widest text-chrome">
                              Raw &amp; ready to sell
                            </span>
                          </div>
                          <div className={`${COL4} px-1 pb-1 pt-1`}>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Item</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Qty</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Cost/unit</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Value</span>
                          </div>

                          {otherReady.map((s, i) => {
                            const cost = Number(s.purchase_price ?? 0);
                            const pks = packLabel(s.pieces_available, s.pieces_per_pack);
                            return (
                              <div key={`ors-${i}`} className={`${COL4} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]`}>
                                <div className="min-w-0">
                                  <p className="font-mono text-[11px] text-ink truncate">{s.product_name}</p>
                                  <p className="font-mono text-[9px] text-ink-soft/60">{s.product_category}</p>
                                </div>
                                <div className="text-right">
                                  <p className={`font-mono text-[11px] font-semibold ${s.pieces_available < 5 ? "text-chili" : "text-ink"}`}>{s.pieces_available}</p>
                                  {pks && <p className="font-mono text-[9px] text-ink-soft/50">{pks}</p>}
                                </div>
                                <span className="self-center font-mono text-[10px] text-ink-soft text-right">{cost > 0 ? bdtD(cost) : "—"}</span>
                                <span className="self-center font-mono text-[11px] text-ink-soft text-right">{cost > 0 ? bdtD(s.pieces_available * cost) : "—"}</span>
                              </div>
                            );
                          })}

                          {[...INGREDIENT_GROUPS, { key: "Supply", icon: "📦" }].flatMap(({ key, icon }) => {
                            const group = rawStock
                              .filter((rs) => rs.ingredient_group === key)
                              .sort(
                                (a, b) =>
                                  a.primary_product.localeCompare(b.primary_product) ||
                                  a.ingredient.localeCompare(b.ingredient)
                              );
                            if (group.length === 0) return [];
                            return [
                              <div key={`grp-${key}`} className="col-span-4 px-1 pt-2 pb-0.5">
                                <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50">
                                  {icon} {key}
                                </span>
                              </div>,
                              ...group.map((rs, i) => {
                                const qty = Number(rs.quantity_available);
                                const cost = Number(rs.cost_per_base_unit);
                                const pks = packLabel(qty, rs.pieces_per_pack);
                                return (
                                  <div key={`raw-${key}-${i}`} className={`${COL4} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]`}>
                                    <div className="min-w-0">
                                      <p className="font-mono text-[11px] text-ink truncate">{rs.ingredient}</p>
                                      <p className="font-mono text-[9px] text-ink-soft/60">{rs.base_unit}</p>
                                    </div>
                                    <div className="text-right">
                                      <p className={`font-mono text-[11px] font-semibold ${qty < 5 ? "text-chili" : "text-ink"}`}>
                                        {qty % 1 === 0 ? qty : qty.toFixed(2)}
                                      </p>
                                      {pks && <p className="font-mono text-[9px] text-ink-soft/50">{pks}</p>}
                                    </div>
                                    <span className="self-center font-mono text-[10px] text-ink-soft text-right">{cost > 0 ? bdtD(cost) : "—"}</span>
                                    <span className="self-center font-mono text-[11px] text-ink-soft text-right">{cost > 0 ? bdtD(qty * cost) : "—"}</span>
                                  </div>
                                );
                              }),
                            ];
                          })}

                          {(otherReadyTotal + rawTotal) > 0 && (
                            <div className="flex justify-end pt-1.5 px-1">
                              <span className="font-mono text-[10px] text-chrome font-semibold">
                                Subtotal: {bdtD(otherReadyTotal + rawTotal)}
                              </span>
                            </div>
                          )}
                        </>
                      )}

                      {/* Grand total */}
                      {beverages.length > 0 && (otherReady.length > 0 || rawStock.length > 0) && (bevTotal + otherReadyTotal + rawTotal) > 0 && (
                        <div className="mt-2 flex justify-end border-t border-dashed border-[#d8cdb0] pt-2 px-1">
                          <span className="font-mono text-[11px] font-semibold text-ink">
                            Total: {bdtD(bevTotal + otherReadyTotal + rawTotal)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </Section>
              );
            })()}

          </div>
        </>
      )}
    </div>
  );
}

// ── stock-in action card ──────────────────────────────────────────────────────

function StockInActionCard({
  record,
  busy,
  onApprove,
  onReject,
}: {
  record: DayOverviewStockIn;
  busy: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="queue-item">
      <div className="qtop">
        <span>Stock in #SI-{String(record.id).padStart(4, "0")}</span>
        <span className="stamp stamp-pending rotate-0">Pending</span>
      </div>
      <div className="qmeta">
        {record.item_count} line{record.item_count !== 1 ? "s" : ""} · by {record.submitted_by_name}
        {record.invoice_number ? ` · ${record.invoice_number}` : ""}
      </div>
      <div className="qbtns">
        <button
          className="approve"
          disabled={busy === `si-${record.id}`}
          onClick={onApprove}
        >
          {busy === `si-${record.id}` ? "…" : "Approve"}
        </button>
        <button
          className="reject"
          disabled={busy === `si-${record.id}`}
          onClick={onReject}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
