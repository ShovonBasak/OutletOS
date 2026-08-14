"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate, timeOf, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type {
  DailyClosing,
  DisplayStock,
  Outlet,
  Paginated,
  PreparationLog,
  StockInRecord,
} from "@/lib/types";

interface CashInfo {
  cash: { id: number; name: string; balance: string };
  accounts: { id: number; name: string; account_type: string }[];
}

export default function StaffHome() {
  const { user } = useAuth();
  const { day, refreshDay, workDate, setWorkDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;

  const [outletObj, setOutletObj] = useState<Outlet | null>(null);
  const [displayStock, setDisplayStock] = useState<DisplayStock[]>([]);
  const [stockInStatus, setStockInStatus] = useState("None today");
  const [preparedToday, setPreparedToday] = useState(0);
  const [closingStatus, setClosingStatus] = useState("Not started");
  const [skipping, setSkipping] = useState(false);
  const [staleDayClosingStatus, setStaleDayClosingStatus] = useState<string | null>(null);

  // Cash card + transfer sheet
  const [cashInfo, setCashInfo] = useState<CashInfo | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [toAccount, setToAccount] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [transferMsg, setTransferMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
    api<CashInfo>("/cash/").then((info) => {
      setCashInfo(info);
      if (!toAccount && info.accounts[0]) setToAccount(String(info.accounts[0].id));
    }).catch(() => {});
  }, [outlet, workDate]);

  // When a stale day is detected and it's IN_PROGRESS, fetch its closing status
  // so we can decide whether to show "Go to closing" vs. "Force close".
  useEffect(() => {
    if (!day || day.date === today()) { setStaleDayClosingStatus(null); return; }
    if (day.status !== "IN_PROGRESS") { setStaleDayClosingStatus(null); return; }
    api<Paginated<DailyClosing>>(`/daily-closings/?outlet=${outlet}&date=${day.date}`)
      .then((d) => setStaleDayClosingStatus(d.results[0]?.status ?? null))
      .catch(() => setStaleDayClosingStatus(null));
  }, [day, outlet]);

  const status = day?.status ?? "NOT_STARTED";
  const readyPieces = displayStock.reduce((s, d) => s + d.pieces_available, 0);

  // A stale day is one where the backend returned a previous (unclosed) day
  // instead of creating today's day.
  const isStaleDay = !!day && day.date !== today();

  const closingColor =
    closingStatus === "Locked" ? "text-leaf-deep font-semibold" :
    closingStatus === "Submitted" ? "text-leaf" :
    "text-ink-soft";

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    setTransferMsg(null);
    setTransferring(true);
    try {
      const res = await api<{ detail: string; new_cash_balance: string }>("/cash/", {
        method: "POST",
        body: JSON.stringify({ to_account: Number(toAccount), amount: transferAmount, note: transferNote }),
      });
      setCashInfo((prev) => prev ? { ...prev, cash: { ...prev.cash, balance: res.new_cash_balance } } : prev);
      setTransferMsg({ ok: true, text: "Transfer recorded." });
      setTransferAmount("");
      setTransferNote("");
    } catch (err: unknown) {
      const body = (err as { body?: { error?: string } })?.body;
      setTransferMsg({ ok: false, text: body?.error ?? "Transfer failed." });
    } finally {
      setTransferring(false);
    }
  }

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
        <h1 className="font-display text-xl font-bold">{outletObj?.name ?? "outlet"}</h1>
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
          {status === "IN_PROGRESS" && (staleDayClosingStatus === "LOCKED" || staleDayClosingStatus === "SUBMITTED") && (
            <>
              <p className="font-mono text-[11px] text-ink-soft">
                Closing is {staleDayClosingStatus.toLowerCase()}. Force close this day to start today.
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
          {status === "IN_PROGRESS" && staleDayClosingStatus !== "LOCKED" && staleDayClosingStatus !== "SUBMITTED" && (
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

          {/* Cash card */}
          {cashInfo && (
            <button
              type="button"
              className="ticket flex items-center justify-between text-left w-full"
              onClick={() => { setTransferOpen(true); setTransferMsg(null); }}
            >
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Shop Cash</p>
                <p className="font-mono text-2xl font-bold text-ink">{bdt(cashInfo.cash.balance)}</p>
              </div>
              <span className="rounded border border-chrome px-2.5 py-1 font-mono text-[11px] text-chrome">
                Transfer →
              </span>
            </button>
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
            <Link href="/staff/other-income" className="tile">
              <span className="n">+</span>
              <span className="l">Other income</span>
            </Link>
          </div>
        </>
      )}

      {/* Transfer bottom sheet */}
      {transferOpen && cashInfo && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-end" onClick={() => setTransferOpen(false)}>
          <div className="absolute inset-0 bg-ink/40" />
          <div
            className="relative w-full max-w-[420px] flex max-h-[85vh] flex-col gap-4 overflow-y-auto rounded-t-2xl bg-paper p-5 pb-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-display text-base font-bold">Transfer cash</h2>
                <p className="font-mono text-[11px] text-ink-soft">
                  Available: {bdt(cashInfo.cash.balance)}
                </p>
              </div>
              <button
                className="font-mono text-[11px] text-ink-soft underline"
                onClick={() => setTransferOpen(false)}
              >
                Cancel
              </button>
            </div>

            <form onSubmit={handleTransfer} className="flex flex-col gap-3">
              <div className="field">
                <span className="field-label">Transfer to</span>
                <CustomSelect
                  options={cashInfo.accounts.map((a) => ({ value: String(a.id), label: a.name }))}
                  value={toAccount}
                  onChange={setToAccount}
                  placeholder="Select account…"
                />
              </div>

              <label className="field">
                <span className="field-label">Amount (৳)</span>
                <input
                  className="field-input"
                  type="number"
                  inputMode="decimal"
                  min="1"
                  max={cashInfo.cash.balance}
                  step="any"
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value)}
                  required
                />
              </label>

              <label className="field">
                <span className="field-label">Note (optional)</span>
                <input
                  className="field-input"
                  value={transferNote}
                  onChange={(e) => setTransferNote(e.target.value)}
                  placeholder="e.g. Bank deposit"
                />
              </label>

              {transferMsg && (
                <p className={`font-mono text-xs ${transferMsg.ok ? "text-leaf-deep" : "text-chili-deep"}`}>
                  {transferMsg.text}
                </p>
              )}

              <button type="submit" className="btn btn-primary" disabled={transferring || !toAccount || !transferAmount}>
                {transferring ? "Transferring…" : "Confirm transfer"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative mt-1">
      <button
        type="button"
        className="field-input flex w-full items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={selected ? "text-ink" : "text-ink-soft"}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="font-mono text-[11px] text-ink-soft">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded border border-[#d8cdb0] bg-paper shadow-lg">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`flex w-full items-center justify-between border-b border-dotted border-[#d8cdb0] px-3 py-2.5 text-left font-mono text-sm last:border-0 transition-colors active:bg-paper-dim ${
                o.value === value ? "bg-action text-gold" : "text-ink hover:bg-paper-dim"
              }`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
              {o.value === value && <span className="text-xs">✓</span>}
            </button>
          ))}
        </div>
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
