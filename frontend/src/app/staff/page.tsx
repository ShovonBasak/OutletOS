"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { shortDate, today } from "@/lib/format";
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
  const { day } = useOperatingDay();
  const outlet = user?.outlet ?? 1;

  const [outletName, setOutletName] = useState("outlet");
  const [readyPieces, setReadyPieces] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);
  const [stockInStatus, setStockInStatus] = useState("None today");
  const [preparedToday, setPreparedToday] = useState(0);
  const [closingStatus, setClosingStatus] = useState("Not started");

  useEffect(() => {
    const t = today();
    api<Paginated<Outlet>>("/outlets/").then((d) => {
      const o = d.results.find((x) => x.id === outlet) ?? d.results[0];
      if (o) setOutletName(o.name);
    });
    api<Paginated<DisplayStock>>(`/display-stock/?outlet=${outlet}`).then((d) =>
      setReadyPieces(d.results.reduce((s, r) => s + r.pieces_available, 0))
    );
    api<Paginated<StockInRecord>>(`/stock-in/?outlet=${outlet}`).then((d) => {
      setHistoryCount(d.count ?? d.results.length);
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
    });
  }, [outlet]);

  const status = day?.status ?? "NOT_STARTED";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Today — {shortDate(today())}</h1>
        <p className="text-xs text-ink-soft">{outletName} outlet</p>
      </div>

      {/* Gated start-of-day wizard */}
      {status !== "IN_PROGRESS" && status !== "CLOSED" && (
        <div className="flex flex-col gap-3">
          {status === "NOT_STARTED" && (
            <>
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
          <div className="ticket">
            <div className="ticket-row">
              <span>Stock in status</span>
              <span className="qty text-ink-soft">{stockInStatus}</span>
            </div>
            <div className="ticket-row">
              <span>Prepared today</span>
              <span className="qty text-ink-soft">{preparedToday} pcs</span>
            </div>
            <div className="ticket-row">
              <span>Closing status</span>
              <span className="qty text-ink-soft">{closingStatus}</span>
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

          <p className="mt-1 text-xs text-ink-soft">Quick actions</p>
          <div className="tilegrid">
            <Link href="/staff/stock" className="tile">
              <span className="n">{readyPieces}</span>
              <span className="l">Pieces in stock</span>
            </Link>
            <Link href="/staff/stock-in" className="tile">
              <span className="n">{historyCount}</span>
              <span className="l">Stock in history</span>
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
          <Link href="/staff/profile" className="text-center font-mono text-[11px] text-ink-soft underline">
            Profile &amp; settings
          </Link>
        </>
      )}
    </div>
  );
}

function WizardStep({
  n,
  title,
  hint,
  href,
  done,
  active,
}: {
  n: number;
  title: string;
  hint: string;
  href: string;
  done: boolean;
  active: boolean;
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
