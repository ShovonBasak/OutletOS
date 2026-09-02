"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { pushPermissionState, subscribeToPush } from "@/lib/push";
import { bdt, bdtD, shortDate, today, timeOf } from "@/lib/format";
import type { DayOverview, DayOverviewStockIn, DayOverviewSalesProduct, DayOverviewTransaction, DayOverviewPeriodicCheck, DayOverviewSupplyStockIn, PackagingLevel } from "@/lib/types";
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
  const [periodicLevels, setPeriodicLevels] = useState<PackagingLevel[]>([]);
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
      const [d, pl] = await Promise.all([
        api<DayOverview>(`/reports/day-overview/?outlet=1&date=${date}`),
        api<PackagingLevel[]>(`/periodic-stock-checks/levels/?outlet=1`),
      ]);
      setData(d);
      setPeriodicLevels(pl);
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
                <span className={`font-mono text-[16px] font-bold leading-tight ${Number(data.pnl.gross_revenue) > 0 ? "text-leaf-deep" : "text-ink"}`}>
                  {bdt(data.pnl.gross_revenue)}
                </span>
                {(Number(data.pnl.commission_total) > 0 || Number(data.pnl.channel_discount) > 0) && (
                  <span className="font-mono text-[9px] text-ink-soft/60 leading-tight">
                    {[
                      Number(data.pnl.commission_total) > 0 && `cmm −${bdt(data.pnl.commission_total)}`,
                      Number(data.pnl.channel_discount) > 0 && `disc −${bdt(data.pnl.channel_discount)}`,
                    ].filter(Boolean).join(" · ")}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-0.5 items-center text-center">
                <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Gross profit</span>
                <span className={`font-mono text-[16px] font-bold leading-tight ${
                  Number(data.pnl.gross_profit) > 0 ? "text-leaf-deep"
                  : Number(data.pnl.gross_profit) < 0 ? "text-chili"
                  : "text-ink"
                }`}>
                  {bdt(data.pnl.gross_profit)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 items-end text-right">
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
              defaultOpen={opDay?.status === "CLOSED"}
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
                    <div className="flex flex-col items-center text-center">
                      <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Online</span>
                      <span className="font-mono text-[13px] font-semibold text-ink">
                        {bdt(data.closing.online_payments)}
                      </span>
                    </div>
                    <div className="flex flex-col items-end text-right">
                      <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Walk-in</span>
                      <span className="font-mono text-[13px] font-semibold text-ink">
                        {bdt(data.closing.total_offline_sales)}
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

            {/* Transactions */}
            {(() => {
              const txns: DayOverviewTransaction[] = data.transactions ?? [];
              const netFlow = txns.reduce((s, t) => s + Number(t.amount), 0);
              const TXN_TYPE_LABEL: Record<string, string> = {
                SALES_COLLECTION: "Sales collection",
                EXPENSE_PAYMENT: "Expense",
                TRANSFER_IN: "Transfer in",
                TRANSFER_OUT: "Transfer out",
                CAPITAL_INJECTION: "Capital injection",
                OWNER_WITHDRAWAL: "Withdrawal",
                ADJUSTMENT: "Adjustment",
                SUPPLIER_ORDER_DEDUCTION: "Supplier payment",
                OTHER_INCOME: "Other income",
              };
              return (
                <Section
                  title="Transactions"
                  badge={txns.length === 0 ? "None" : `${txns.length} · net ${bdt(netFlow)}`}
                  badgeColor={
                    txns.length === 0 ? "bg-ink-soft/10 text-ink-soft"
                    : netFlow >= 0 ? "bg-leaf/10 text-leaf-deep border border-leaf/20"
                    : "bg-chili/10 text-chili border border-chili/20"
                  }
                  defaultOpen={false}
                >
                  {txns.length === 0 ? (
                    <p className="font-mono text-[11px] text-ink-soft italic">No transactions recorded for this day.</p>
                  ) : (
                    <div className="flex flex-col gap-0 -mx-1">
                      <div className="grid grid-cols-[minmax(0,1fr)_5rem] px-1 pb-1">
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Type · Account</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Amount</span>
                      </div>
                      {txns.map((t) => {
                        const amt = Number(t.amount);
                        return (
                          <div
                            key={t.id}
                            className="grid grid-cols-[minmax(0,1fr)_5rem] rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]"
                          >
                            <div className="min-w-0 pr-2">
                              <p className="font-mono text-[11px] text-ink truncate">
                                {TXN_TYPE_LABEL[t.transaction_type] ?? t.transaction_type}
                              </p>
                              <p className="font-mono text-[9px] text-ink-soft/60 truncate">{t.account_name}</p>
                              {t.note && (
                                <p className="font-mono text-[9px] text-ink-soft/50 truncate italic">{t.note}</p>
                              )}
                            </div>
                            <span className={`self-center font-mono text-[12px] font-semibold text-right ${
                              amt > 0 ? "text-leaf-deep" : amt < 0 ? "text-chili" : "text-ink-soft"
                            }`}>
                              {amt >= 0 ? "+" : ""}{bdt(t.amount)}
                            </span>
                          </div>
                        );
                      })}
                      <div className="mt-2 flex items-center justify-between border-t border-dashed border-[#d8cdb0] pt-2 px-1">
                        <span className="font-mono text-[10px] text-ink-soft">Net flow</span>
                        <span className={`font-mono text-[12px] font-bold ${
                          netFlow > 0 ? "text-leaf-deep" : netFlow < 0 ? "text-chili" : "text-ink-soft"
                        }`}>
                          {netFlow >= 0 ? "+" : ""}{bdt(netFlow)}
                        </span>
                      </div>
                    </div>
                  )}
                </Section>
              );
            })()}

            {/* Day end / Current stock */}
            {(() => {
              const allDisplay = data.display_stock.filter(s => !s.requires_preparation);
              const rawStock = data.raw_stock ?? [];
              const supplyItems = periodicLevels;
              const totalItems = allDisplay.length + rawStock.length + supplyItems.length;

              const displayTotal = allDisplay.reduce((sum, s) => sum + s.pieces_available * Number(s.purchase_price ?? 0), 0);
              const rawTotal = rawStock.reduce((sum, rs) => sum + Number(rs.quantity_available) * Number(rs.cost_per_base_unit), 0);
              const supplyTotal = supplyItems.reduce((sum, s) => sum + Number(s.current_qty) * Number(s.cost_per_base_unit ?? 0), 0);

              const COL4 = "grid grid-cols-[minmax(0,1fr)_4.5rem_6rem_6.5rem]";
              const sectionTitle = opDay?.status === "CLOSED" ? "Day end stock" : "Current stock";

              // Single unified group per category: products (display_stock) + ingredients (raw_stock) merged
              const unifiedGroups = [
                ...INGREDIENT_GROUPS,
                { key: "Supply", icon: "📦" },
              ].map(({ key, icon }) => ({
                key,
                icon,
                products: allDisplay
                  .filter(s => s.product_category === key)
                  .sort((a, b) => a.product_name.localeCompare(b.product_name)),
                ingredients: rawStock
                  .filter(rs => rs.ingredient_group === key)
                  .sort((a, b) =>
                    a.primary_product.localeCompare(b.primary_product) ||
                    a.ingredient.localeCompare(b.ingredient)
                  ),
              })).filter(g => g.products.length > 0 || g.ingredients.length > 0);

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

                      {/* Column headers */}
                      <div className={`${COL4} px-1 pb-1 pt-1`}>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Item</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-center">Qty</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Cost</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Value</span>
                      </div>

                      {/* Unified category groups — products + ingredients under one header */}
                      {unifiedGroups.flatMap(({ key, icon, products, ingredients }, gi) => [
                        <div key={`grp-${key}`} className={`px-1 pb-0.5 ${gi === 0 ? "pt-1" : "pt-3"}`}>
                          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/60">
                            {icon} {key}
                          </span>
                        </div>,
                        // Product rows (ready-to-sell pieces)
                        ...products.map((s, i) => {
                          const cost = Number(s.purchase_price ?? 0);
                          const pks = packLabel(s.pieces_available, s.pieces_per_pack);
                          return (
                            <div key={`prod-${key}-${i}`} className={`${COL4} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]`}>
                              <div className="min-w-0">
                                <p className="font-mono text-[11px] text-ink leading-tight break-words">{s.product_name}</p>
                              </div>
                              <div className="text-center">
                                <p className={`font-mono text-[11px] font-semibold ${s.pieces_available === 0 ? "text-ink-soft/40" : s.pieces_available < 5 ? "text-chili" : "text-ink"}`}>{s.pieces_available}</p>
                                {pks && <p className="font-mono text-[9px] text-ink-soft/50">{pks}</p>}
                              </div>
                              <span className="self-center font-mono text-[10px] text-ink-soft text-right">{cost > 0 ? bdtD(cost) : "—"}</span>
                              <span className="self-center font-mono text-[11px] text-ink-soft text-right">{cost > 0 && s.pieces_available > 0 ? bdtD(s.pieces_available * cost) : "—"}</span>
                            </div>
                          );
                        }),
                        // Ingredient rows (raw material)
                        ...ingredients.map((rs, i) => {
                          const qty = Number(rs.quantity_available);
                          const cost = Number(rs.cost_per_base_unit);
                          const pks = packLabel(qty, rs.pieces_per_pack);
                          return (
                            <div key={`raw-${key}-${i}`} className={`${COL4} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]`}>
                              <div className="min-w-0">
                                <p className="font-mono text-[11px] text-ink leading-tight break-words">{rs.ingredient}</p>
                                <p className="font-mono text-[9px] text-ink-soft/60">{rs.base_unit}</p>
                              </div>
                              <div className="text-center">
                                <p className={`font-mono text-[11px] font-semibold ${qty === 0 ? "text-ink-soft/40" : qty < 5 ? "text-chili" : "text-ink"}`}>
                                  {qty % 1 === 0 ? qty : qty.toFixed(2)}
                                </p>
                                {pks && <p className="font-mono text-[9px] text-ink-soft/50">{pks}</p>}
                              </div>
                              <span className="self-center font-mono text-[10px] text-ink-soft text-right">{cost > 0 ? bdtD(cost) : "—"}</span>
                              <span className="self-center font-mono text-[11px] text-ink font-medium text-right">{cost > 0 && qty > 0 ? bdtD(qty * cost) : "—"}</span>
                            </div>
                          );
                        }),
                      ])}

                      {/* Supplies */}
                      {supplyItems.length > 0 && (
                        <>
                          <div className="px-1 pt-3 pb-0.5">
                            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/60">📦 Supplies</span>
                          </div>
                          <div className={`${COL4} px-1 pb-1 pt-1`}>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Item</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-center">Qty</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Cost</span>
                            <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Value</span>
                          </div>
                          {supplyItems.map((s) => {
                            const qty = Number(s.current_qty);
                            const cost = Number(s.cost_per_base_unit ?? 0);
                            const pks = packLabel(qty, s.pieces_per_pack);
                            const zero = qty === 0;
                            const low = qty < 5;
                            return (
                              <div key={`sup-${s.ingredient}`} className={`${COL4} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]`}>
                                <div className="min-w-0">
                                  <p className="font-mono text-[11px] text-ink leading-tight break-words">{s.ingredient_display_name}</p>
                                  {s.last_checked_at && (
                                    <p className="font-mono text-[9px] text-ink-soft/60">{shortDate(s.last_checked_at)} · {timeOf(s.last_checked_at)}</p>
                                  )}
                                </div>
                                <div className="text-center">
                                  <p className={`font-mono text-[11px] font-semibold ${zero ? "text-chili" : low ? "text-gold-deep" : "text-ink"}`}>
                                    {qty % 1 === 0 ? qty : qty.toFixed(2)}
                                  </p>
                                  {pks && <p className="font-mono text-[9px] text-ink-soft/50">{pks}</p>}
                                </div>
                                <span className="self-center font-mono text-[10px] text-ink-soft text-right">{cost > 0 ? bdtD(cost) : "—"}</span>
                                <span className="self-center font-mono text-[11px] text-ink font-medium text-right">{cost > 0 ? bdtD(qty * cost) : "—"}</span>
                              </div>
                            );
                          })}
                        </>
                      )}

                      {/* Grand total */}
                      {(displayTotal + rawTotal + supplyTotal) > 0 && (
                        <div className="mt-2 flex justify-end border-t border-dashed border-[#d8cdb0] pt-2 px-1">
                          <span className="font-mono text-[11px] font-semibold text-ink">
                            Total: {bdtD(displayTotal + rawTotal + supplyTotal)}
                          </span>
                        </div>
                      )}
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
                  defaultOpen={opDay?.status !== "CLOSED" && rows.length > 0}
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
              defaultOpen={false}
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
              defaultOpen={false}
            >
              {data.day_start_checks.length === 0 ? (
                <p className="font-mono text-[11px] text-ink-soft italic">
                  {opDay ? "No stock checks recorded." : "Day not started yet."}
                </p>
              ) : (
                <div className="flex flex-col gap-0 -mx-1">
                  {(() => {
                    const COL = "grid grid-cols-[minmax(0,1fr)_4rem_4rem_3.5rem]";

                    const renderRow = (chk: (typeof data.day_start_checks)[0], key: string) => {
                      const disc = Number(chk.discrepancy_qty);
                      const sysQty = Number(chk.system_qty);
                      const confQty = Number(chk.confirmed_qty);
                      const isShortfall = disc > 0;
                      const isSurplus = disc < 0;
                      const sysPacks = packLabel(sysQty, chk.pieces_per_pack);
                      const confPacks = packLabel(confQty, chk.pieces_per_pack);
                      const fmtQty = (n: number) => n % 1 === 0 ? String(n) : n.toFixed(2);
                      return (
                        <div
                          key={key}
                          className={`${COL} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8] ${
                            isShortfall ? "bg-chili/5" : isSurplus ? "bg-gold/5" : ""
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="font-mono text-[11px] text-ink leading-tight break-words">{chk.ingredient}</p>
                            <p className="font-mono text-[9px] text-ink-soft/60">{chk.base_unit}</p>
                          </div>
                          <div className="text-center">
                            <p className="font-mono text-[11px] text-ink-soft">{fmtQty(sysQty)}</p>
                            {sysPacks && <p className="font-mono text-[9px] text-ink-soft/50">{sysPacks}</p>}
                          </div>
                          <div className="text-center">
                            <p className={`font-mono text-[11px] font-semibold ${isShortfall ? "text-chili" : isSurplus ? "text-gold-deep" : "text-ink"}`}>
                              {fmtQty(confQty)}
                            </p>
                            {confPacks && <p className="font-mono text-[9px] text-ink-soft/50">{confPacks}</p>}
                          </div>
                          <span className={`self-center font-mono text-[11px] font-semibold text-right ${
                            isShortfall ? "text-chili" : isSurplus ? "text-gold-deep" : "text-ink-soft/40"
                          }`}>
                            {disc === 0 ? "—" : disc > 0 ? `−${fmtQty(disc)}` : `+${fmtQty(Math.abs(disc))}`}
                          </span>
                          {(isShortfall || isSurplus) && (
                            <div className="col-span-4 pb-0.5">
                              <span className="font-mono text-[10px] text-ink-soft/70 capitalize">
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
                    };

                    const knownGroups = new Set(INGREDIENT_GROUPS.map(g => g.key));
                    const grouped = [...INGREDIENT_GROUPS, { key: "Other", icon: "🗂" }].flatMap(({ key, icon }, gi) => {
                      const rows = data.day_start_checks.filter(c => c.ingredient_group === key);
                      if (rows.length === 0) return [];
                      return [
                        <div key={`grp-${key}`} className={`px-1 pb-0.5 ${gi === 0 ? "pt-1" : "pt-3"}`}>
                          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/60">
                            {icon} {key}
                          </span>
                        </div>,
                        ...rows.map((chk, i) => renderRow(chk, `${key}-${i}`)),
                      ];
                    });

                    const ungrouped = data.day_start_checks.filter(
                      c => !knownGroups.has(c.ingredient_group) && c.ingredient_group !== "Other"
                    );

                    return (
                      <>
                        <div className={`${COL} px-1 pb-1 pt-1`}>
                          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Ingredient</span>
                          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-center">System</span>
                          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-center">Confirmed</span>
                          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Δ</span>
                        </div>
                        {grouped}
                        {ungrouped.map((chk, i) => renderRow(chk, `ung-${i}`))}
                      </>
                    );
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

            {/* Packaging & Supplies counts */}
            {(() => {
              type SupplyEntry =
                | { kind: "recount"; time: string; data: DayOverviewPeriodicCheck }
                | { kind: "stockin"; time: string; data: DayOverviewSupplyStockIn };

              const entries: SupplyEntry[] = [
                ...(data.periodic_checks ?? []).map((c) => ({
                  kind: "recount" as const,
                  time: c.checked_at,
                  data: c,
                })),
                ...(data.supply_stock_ins ?? []).filter((s) => s.approved_at).map((s) => ({
                  kind: "stockin" as const,
                  time: s.approved_at!,
                  data: s,
                })),
              ].sort((a, b) => a.time.localeCompare(b.time));

              // Build running balance per ingredient to compute before/after for every entry.
              // Anchor: for each ingredient, the first recount's "before" =
              //   counted_qty + consumed_since_last_check - stock_in_since_last_check
              // (this is the level at the previous periodic check, before any of today's events)
              type Computed = { before: number | null; adj: number; after: number | null };
              const computed: Computed[] = entries.map(() => ({ before: null, adj: 0, after: null }));

              const byIng = new Map<string, number[]>();
              entries.forEach((e, i) => {
                const name = e.data.ingredient_name;
                if (!byIng.has(name)) byIng.set(name, []);
                byIng.get(name)!.push(i);
              });

              const openingLevels: Record<string, string> = data.supply_opening_levels ?? {};

              for (const [ingName, indices] of byIng.entries()) {
                // Anchor: opening balance from backend (level at start of viewed day)
                const openingStr = openingLevels[ingName];
                let running: number | null = openingStr != null ? Number(openingStr) : null;

                for (const i of indices) {
                  const e = entries[i];
                  if (e.kind === "recount") {
                    const c = e.data;
                    const after = Number(c.counted_qty);
                    computed[i].before = running;
                    computed[i].after = after;
                    computed[i].adj = running !== null ? after - running : 0;
                    running = after;
                  } else {
                    const qty = Number(e.data.quantity_added);
                    computed[i].before = running;
                    computed[i].adj = qty;
                    computed[i].after = running !== null ? running + qty : null;
                    running = computed[i].after ?? (running !== null ? running + qty : null);
                  }
                }
              }

              const COLS = "grid grid-cols-[minmax(0,1fr)_3rem_3.5rem_3rem]";

              const fmt = (n: number | null) =>
                n === null ? "—" : String(Math.round(n * 100) / 100);

              return (
                <Section
                  title="Packaging & Supplies"
                  badge={entries.length === 0 ? "No entries" : `${entries.length} log${entries.length !== 1 ? "s" : ""}`}
                  badgeColor={entries.length > 0 ? "bg-chrome/10 text-chrome border border-chrome/20" : "bg-ink-soft/10 text-ink-soft"}
                  defaultOpen={false}
                >
                  {entries.length === 0 ? (
                    <p className="font-mono text-[11px] text-ink-soft italic">
                      No supply counts recorded for this day.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-0 -mx-1">
                      <div className={`${COLS} px-1 pb-1`}>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Item</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">Before</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-center">Adj</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft text-right">After</span>
                      </div>
                      {entries.map((entry, idx) => {
                        const { before, adj, after } = computed[idx];
                        const adjR = Math.round(adj * 100) / 100;
                        const afterN = after !== null ? Math.round(after * 100) / 100 : null;

                        if (entry.kind === "recount") {
                          const c = entry.data;
                          return (
                            <div
                              key={`rc-${c.id}`}
                              className={`${COLS} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]`}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1 flex-wrap">
                                  <p className="font-mono text-[11px] text-ink leading-tight break-words">{c.ingredient_name}</p>
                                  <span className="shrink-0 rounded-sm bg-chrome/10 px-1 py-px font-mono text-[8px] uppercase tracking-wide text-chrome">Recount</span>
                                </div>
                                <p className="font-mono text-[9px] text-ink-soft/60">
                                  {timeOf(c.checked_at)}
                                  {c.checked_by_name ? ` · ${c.checked_by_name}` : ""}
                                  {c.note ? ` · ${c.note}` : ""}
                                </p>
                              </div>
                              <span className="self-center font-mono text-[11px] text-ink-soft text-right">{fmt(before)}</span>
                              <span className={`self-center font-mono text-[11px] font-semibold text-center ${adjR < 0 ? "text-chili" : adjR > 0 ? "text-leaf-deep" : "text-ink-soft/40"}`}>
                                {adjR === 0 ? "—" : adjR > 0 ? `+${adjR}` : `${adjR}`}
                              </span>
                              <span className={`self-center font-mono text-[11px] font-semibold text-right ${afterN === 0 ? "text-chili" : afterN !== null && afterN < 5 ? "text-gold-deep" : "text-ink"}`}>
                                {fmt(after)}
                              </span>
                            </div>
                          );
                        } else {
                          const s = entry.data;
                          return (
                            <div
                              key={`si-${idx}`}
                              className={`${COLS} rounded px-1 py-1.5 border-t border-dashed border-[#e8dfc8]`}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1 flex-wrap">
                                  <p className="font-mono text-[11px] text-ink leading-tight break-words">{s.ingredient_name}</p>
                                  <span className="shrink-0 rounded-sm bg-leaf-deep/10 px-1 py-px font-mono text-[8px] uppercase tracking-wide text-leaf-deep">Stock-in</span>
                                </div>
                                <p className="font-mono text-[9px] text-ink-soft/60">
                                  {s.approved_at ? timeOf(s.approved_at) : ""}
                                  {s.approved_by_name ? ` · ${s.approved_by_name}` : ""}
                                </p>
                              </div>
                              <span className="self-center font-mono text-[11px] text-ink-soft text-right">{fmt(before)}</span>
                              <span className="self-center font-mono text-[11px] font-semibold text-leaf-deep text-center">+{adjR}</span>
                              <span className={`self-center font-mono text-[11px] font-semibold text-right ${afterN === 0 ? "text-chili" : afterN !== null && afterN < 5 ? "text-gold-deep" : "text-ink"}`}>
                                {fmt(after)}
                              </span>
                            </div>
                          );
                        }
                      })}
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
