"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate, timeOf, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";

interface CashInfo {
  cash: { id: number; name: string; balance: string };
  accounts: { id: number; name: string; account_type: string }[];
}

interface HomeSummary {
  allow_staff_date_selection: boolean;
  stock_in: { draft_item_count: number | null; latest_status: string } | null;
  closing: { id: number; status: string; total_sale: string; has_flag: boolean } | null;
}

export default function StaffHome() {
  const { user } = useAuth();
  const { day, refreshDay, workDate, setWorkDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;

  const [allowDateSelection, setAllowDateSelection] = useState(false);
  const [stockInStatus, setStockInStatus] = useState("None today");
  const [closingStatus, setClosingStatus] = useState("Not started");
  const [rawClosingStatus, setRawClosingStatus] = useState<string | null>(null);
  const [totalSale, setTotalSale] = useState<string | null>(null);
  const [closingHasFlag, setClosingHasFlag] = useState(false);
  const [skipping, setSkipping] = useState(false);

  // Cash card
  const [cashInfo, setCashInfo] = useState<CashInfo | null>(null);

  const prevCtx = useRef({ outlet: 0, workDate: "" });

  useEffect(() => {
    const t = workDate || today();
    if (prevCtx.current.outlet === outlet && prevCtx.current.workDate === t) return;
    prevCtx.current = { outlet, workDate: t };
    Promise.allSettled([
      api<HomeSummary>(`/home-summary/?outlet=${outlet}&date=${t}`),
      api<CashInfo>("/cash/"),
    ]).then(([summaryRes, cashRes]) => {
      if (summaryRes.status === "fulfilled") {
        const s = summaryRes.value;
        setAllowDateSelection(s.allow_staff_date_selection);
        if (s.stock_in) {
          const { draft_item_count, latest_status } = s.stock_in;
          if (draft_item_count !== null) {
            setStockInStatus(`Draft — ${draft_item_count} item${draft_item_count === 1 ? "" : "s"}`);
          } else {
            setStockInStatus(latest_status.charAt(0) + latest_status.slice(1).toLowerCase());
          }
        }
        if (s.closing) {
          setRawClosingStatus(s.closing.status);
          setClosingStatus(s.closing.status.charAt(0) + s.closing.status.slice(1).toLowerCase());
          setTotalSale(s.closing.total_sale);
          setClosingHasFlag(s.closing.has_flag);
        }
      }
      if (cashRes.status === "fulfilled") {
        setCashInfo(cashRes.value);
      }
    });
  }, [outlet, workDate]);

  const status = day?.status ?? "NOT_STARTED";

  // A stale day is one where the backend returned a previous (unclosed) day
  // instead of creating today's day.
  const isStaleDay = !!day && day.date !== today();

  const closingColor =
    closingStatus === "Locked" ? "text-leaf-deep font-semibold" :
    closingStatus === "Submitted" ? "text-leaf" :
    "text-ink-soft";

  async function handleSkipDay() {
    if (!day) return;
    setSkipping(true);
    try {
      await api(`/operating-days/${day.id}/force-close/`, { method: "POST" });
      await refreshDay();
    } finally {
      setSkipping(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">{user?.outlet_name ?? "outlet"}</h1>
        <p className="text-xs text-ink-soft">{shortDate(day?.date || workDate || today())}</p>
      </div>

      {/* Stale-day warning — shown when a previous day is blocking today */}
      {isStaleDay && (
        <div className="rounded border border-chili/50 bg-chili/10 px-4 py-3 flex flex-col gap-2">
          <p className="font-mono text-xs font-semibold text-chili">
            {shortDate(day!.date)} is not closed — blocking today
          </p>

          {/* Day never really started — just skip it */}
          {(status === "NOT_STARTED" || status === "STOCK_CONFIRMED") && (
            <>
              <p className="font-mono text-[11px] text-ink-soft">
                This day was not fully started. Skip it to begin today.
              </p>
              <button
                className="btn btn-primary self-start !py-1.5 !px-4 !text-xs"
                disabled={skipping}
                onClick={handleSkipDay}
              >
                {skipping ? "Skipping…" : "Skip this day"}
              </button>
            </>
          )}

          {/* Closing is locked or submitted — nothing left to do, just force-close the day */}
          {status === "IN_PROGRESS" && (rawClosingStatus === "LOCKED" || rawClosingStatus === "SUBMITTED") && (
            <>
              <p className="font-mono text-[11px] text-ink-soft">
                Closing is {rawClosingStatus.toLowerCase()}. Force close this day to start today.
              </p>
              <button
                className="btn btn-primary self-start !py-1.5 !px-4 !text-xs"
                disabled={skipping}
                onClick={handleSkipDay}
              >
                {skipping ? "Closing…" : "Force close this day"}
              </button>
            </>
          )}

          {/* Closing still open — staff needs to complete it first, but also offer escape hatch */}
          {status === "IN_PROGRESS" && rawClosingStatus !== "LOCKED" && rawClosingStatus !== "SUBMITTED" && (
            <>
              <p className="font-mono text-[11px] text-ink-soft">
                Complete and submit the daily closing to start today.
              </p>
              <Link href="/staff/closing" className="btn btn-primary self-start !py-1.5 !px-4 !text-xs text-center">
                Go to closing
              </Link>
              <button
                className="mt-1 font-mono text-[11px] text-chili underline self-start"
                disabled={skipping}
                onClick={handleSkipDay}
              >
                {skipping ? "Closing…" : "Force close without completing →"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Gated start-of-day wizard — only when not blocked by a stale day */}
      {!isStaleDay && status !== "IN_PROGRESS" && status !== "CLOSED" && (
        <div className="flex flex-col gap-3">
          {status === "NOT_STARTED" && (
            <>
              {/* Date selector — only when owner has enabled it */}
              {allowDateSelection && (
                <div className="ticket overflow-hidden flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-ink-soft shrink-0">
                      Operating date
                    </span>
                    {workDate !== today() && (
                      <button
                        className="font-mono text-[10px] text-ink-soft underline shrink-0"
                        onClick={() => setWorkDate(today())}
                      >
                        reset to today
                      </button>
                    )}
                  </div>
                  <input
                    type="date"
                    className="field-input w-full min-w-0"
                    value={workDate || today()}
                    max={today()}
                    onChange={(e) => e.target.value && setWorkDate(e.target.value)}
                  />
                  {workDate && workDate !== today() && (
                    <p className="font-mono text-[10px] text-gold-deep">
                      Entering data for {shortDate(workDate)} — not today
                    </p>
                  )}
                </div>
              )}

              <Link href="/staff/day-start" className="btn btn-primary text-center">
                ▶ Start your day
              </Link>
              <Link
                href="/staff/closing?view=yesterday"
                className="text-center font-mono text-[11px] text-ink-soft underline"
              >
                view yesterday&apos;s summary
              </Link>
            </>
          )}
          <div className="flex flex-col gap-2">
            <WizardStep
              n={1}
              title="Day-start stock"
              hint="Confirm ingredient stock carried from yesterday"
              href="/staff/day-start"
              done={status === "STOCK_CONFIRMED"}
              active={status === "NOT_STARTED"}
            />
            <WizardStep
              n={2}
              title="Move yesterday's leftovers"
              hint="Carry prepared items into today's stock"
              href="/staff/prep/carry-forward"
              done={false}
              active={status === "STOCK_CONFIRMED"}
            />
          </div>
        </div>
      )}

      {/* Day summary — only while the day is open */}
      {(status === "IN_PROGRESS" || status === "CLOSED") && (
        <>
          <div className="ticket flex flex-col gap-0">
            {day?.started_at && (
              <div className="ticket-row">
                <span>Opened at</span>
                <span className="qty">{timeOf(day.started_at)}</span>
              </div>
            )}
            {totalSale !== null && Number(totalSale) > 0 && (
              <div className="ticket-row">
                <span>Revenue</span>
                <span className="qty text-leaf-deep">{bdt(totalSale)}</span>
              </div>
            )}
            <div className="ticket-row">
              <span>Stock in</span>
              <span className="qty text-ink-soft">{stockInStatus}</span>
            </div>
            <div className="ticket-row">
              <span>Closing</span>
              <span className={`qty ${closingColor}`}>
                {closingStatus}
                {closingHasFlag && <span className="ml-1.5 font-mono text-[10px] text-chili">⚠ variance</span>}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 text-[11px]">
            <Link href="/staff/day-start" className="font-mono text-gold-deep underline">
              Edit day-start stock
            </Link>
            <Link href="/staff/prep/carry-forward" className="font-mono text-gold-deep underline">
              Edit carry-forward
            </Link>
          </div>
        </>
      )}

      {/* Cash card — always visible */}
      {cashInfo && (
        <Link
          href="/staff/cash"
          className="ticket flex items-center justify-between text-left w-full"
        >
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Shop Cash</p>
            <p className="font-mono text-2xl font-bold text-ink">{bdt(cashInfo.cash.balance)}</p>
          </div>
          <span className="rounded border border-chrome px-2.5 py-1 font-mono text-[11px] text-chrome">
            View →
          </span>
        </Link>
      )}

      {/* Quick action tiles — always visible */}
      <div className="tilegrid">
        <Link href="/staff/closing/history" className="tile">
          <span className="n">≡</span>
          <span className="l">Closing history</span>
        </Link>
        <Link href="/staff/fryer-oil" className="tile">
          <span className="n">🛢</span>
          <span className="l">Log oil change</span>
        </Link>
        {(status === "IN_PROGRESS" || status === "CLOSED") && (
          <>
            <Link href="/staff/closing/stock" className="tile">
              <span className="n">▦</span>
              <span className="l">Stock summary</span>
            </Link>
            <Link href="/staff/packaging" className="tile">
              <span className="n">▦</span>
              <span className="l">Packaging &amp; supplies</span>
            </Link>
            <Link href="/staff/expense" className="tile">
              <span className="n">+</span>
              <span className="l">Add expense</span>
            </Link>
            <Link href="/staff/other-income" className="tile">
              <span className="n">+</span>
              <span className="l">Other income</span>
            </Link>
          </>
        )}
      </div>

    </div>
  );
}

function WizardStep({
  n, title, hint, href, done, active,
}: {
  n: number; title: string; hint: string; href: string; done: boolean; active: boolean;
}) {
  const inner = (
    <div
      className={`flex items-center gap-3 rounded border px-4 py-3 ${
        done
          ? "border-leaf/40 bg-leaf/10"
          : active
            ? "border-gold/50 bg-gold/10"
            : "border-[#d8cdb0] bg-[#fffdf7] opacity-60"
      }`}
    >
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full font-mono text-xs ${
          done ? "bg-leaf text-white" : "bg-paper-dim text-ink-soft"
        }`}
      >
        {done ? "✓" : active ? n : "🔒"}
      </span>
      <span className="flex-1">
        <span className="block font-display text-sm font-bold">{title}</span>
        <span className="block font-mono text-[11px] text-ink-soft">{hint}</span>
      </span>
      {(active || done) && <span className="font-mono text-ink-soft">›</span>}
    </div>
  );
  return active || done ? <Link href={href}>{inner}</Link> : inner;
}
