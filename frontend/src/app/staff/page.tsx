"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { shortDate, timeOf, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type {
  DailyClosing,
  DisplayStock,
  Outlet,
  Paginated,
  PreparationLog,
  StockInRecord,
} from "@/lib/types";

export default function StaffHome() {
  const { user } = useAuth();
  const { day, workDate, setWorkDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;

  const [outletObj, setOutletObj] = useState<Outlet | null>(null);
  const [displayStock, setDisplayStock] = useState<DisplayStock[]>([]);
  const [stockInStatus, setStockInStatus] = useState("None today");
  const [preparedToday, setPreparedToday] = useState(0);
  const [closingStatus, setClosingStatus] = useState("Not started");

  useEffect(() => {
    const t = workDate || today();
    api<Paginated<Outlet>>("/outlets/").then((d) => {
      const o = d.results.find((x) => x.id === outlet) ?? d.results[0];
      if (o) setOutletObj(o);
    });
    api<Paginated<DisplayStock>>(`/display-stock/?outlet=${outlet}`).then((d) =>
      setDisplayStock(d.results)
    );
    api<Paginated<StockInRecord>>(`/stock-in/?outlet=${outlet}`).then((d) => {
      const draft = d.results.find((r) => r.status === "DRAFT");
      const latest = d.results[0];
      if (draft) setStockInStatus(`Draft — ${draft.items.length} item${draft.items.length === 1 ? "" : "s"}`);
      else if (latest) setStockInStatus(latest.status.charAt(0) + latest.status.slice(1).toLowerCase());
    });
    api<Paginated<PreparationLog>>(`/preparation-logs/?outlet=${outlet}&today=true`).then((d) =>
      setPreparedToday(d.results.reduce((s, l) => s + l.pieces_prepared, 0))
    );
    api<Paginated<DailyClosing>>(`/daily-closings/?outlet=${outlet}&date=${t}`).then((d) => {
      const c = d.results[0];
      if (c) setClosingStatus(c.status.charAt(0) + c.status.slice(1).toLowerCase());
      else setClosingStatus("Not started");
    });
  }, [outlet, workDate]);

  const status = day?.status ?? "NOT_STARTED";
  const readyPieces = displayStock.reduce((s, d) => s + d.pieces_available, 0);
  const readyProducts = displayStock.filter((d) => d.pieces_available > 0);

  const closingColor =
    closingStatus === "Locked" ? "text-leaf-deep font-semibold" :
    closingStatus === "Submitted" ? "text-leaf" :
    "text-ink-soft";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">{outletObj?.name ?? "outlet"}</h1>
        <p className="text-xs text-ink-soft">{shortDate(workDate || today())}</p>
      </div>

      {/* Gated start-of-day wizard */}
      {status !== "IN_PROGRESS" && status !== "CLOSED" && (
        <div className="flex flex-col gap-3">
          {status === "NOT_STARTED" && (
            <>
              {/* Date selector — only when owner has enabled it */}
              {outletObj?.allow_staff_date_selection && (
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

      {(status === "IN_PROGRESS" || status === "CLOSED") && (
        <>
          {/* Day summary */}
          <div className="ticket flex flex-col gap-0">
            {day?.started_at && (
              <div className="ticket-row">
                <span>Opened at</span>
                <span className="qty">{timeOf(day.started_at)}</span>
              </div>
            )}
            <div className="ticket-row">
              <span>Prepared today</span>
              <span className="qty text-ink-soft">{preparedToday} pcs</span>
            </div>
            <div className="ticket-row">
              <span>Stock in</span>
              <span className="qty text-ink-soft">{stockInStatus}</span>
            </div>
            <div className="ticket-row">
              <span>Closing</span>
              <span className={`qty ${closingColor}`}>{closingStatus}</span>
            </div>
          </div>

          {/* Ready-to-sell grid */}
          {readyProducts.length > 0 && (
            <div>
              <p className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-soft">
                Ready to sell — {readyPieces} pcs total
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {readyProducts.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between rounded border border-[#d8cdb0] bg-paper px-2.5 py-2"
                  >
                    <span className="font-mono text-[11px] text-ink truncate">{d.product_name}</span>
                    <span className="ml-2 shrink-0 font-mono text-[13px] font-bold text-ink">
                      {d.pieces_available}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Edit links */}
          <div className="flex flex-wrap gap-3 text-[11px]">
            <Link href="/staff/day-start" className="font-mono text-gold-deep underline">
              Edit day-start stock
            </Link>
            <Link href="/staff/prep/carry-forward" className="font-mono text-gold-deep underline">
              Edit carry-forward
            </Link>
          </div>

          {/* Quick action tiles */}
          <div className="tilegrid">
            <Link href="/staff/stock" className="tile">
              <span className="n">{readyPieces}</span>
              <span className="l">Stock overview</span>
            </Link>
            <Link href="/staff/closing/history" className="tile">
              <span className="n">≡</span>
              <span className="l">Closing history</span>
            </Link>
            <Link href="/staff/packaging" className="tile">
              <span className="n">▦</span>
              <span className="l">Packaging &amp; supplies</span>
            </Link>
            <Link href="/staff/expense" className="tile">
              <span className="n">+</span>
              <span className="l">Add expense</span>
            </Link>
          </div>
        </>
      )}
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
