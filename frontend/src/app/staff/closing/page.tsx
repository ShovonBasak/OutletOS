"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing, invalidateClosingCache } from "@/lib/closing";
import { bdt, shortDate, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import { Stamp } from "@/components/Stamp";
import type { DailyClosing, Paginated, Product } from "@/lib/types";

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ClosingHubPage() {
  return (
    <Suspense fallback={<p className="font-mono text-xs text-ink-soft">Loading closing…</p>}>
      <ClosingHub />
    </Suspense>
  );
}

function ClosingHub() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewYesterday = searchParams.get("view") === "yesterday";
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = viewYesterday ? yesterday() : (workDate || today());
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [totalProducts, setTotalProducts] = useState(0);
  const [busy, setBusy] = useState(false);

  const prevCtx = useRef({ outlet: 0, opDate: "", viewYesterday: false });

  async function refresh() {
    if (viewYesterday) {
      const res = await api<Paginated<DailyClosing>>(`/daily-closings/?outlet=${outlet}&date=${opDate}&expand=full`);
      if (res.results[0]) {
        setClosing(res.results[0]);
      } else {
        setNotFound(true);
      }
      return;
    }
    const [c, p] = await Promise.all([
      getOrCreateTodayClosing(outlet, opDate),
      api<Paginated<Product>>("/products/?active=true&product_type=SINGLE"),
    ]);
    setClosing(c);
    setTotalProducts(p.results.length);
  }
  useEffect(() => {
    const ctx = { outlet, opDate, viewYesterday };
    if (
      prevCtx.current.outlet === ctx.outlet &&
      prevCtx.current.opDate === ctx.opDate &&
      prevCtx.current.viewYesterday === ctx.viewYesterday
    ) return;
    prevCtx.current = ctx;
    setClosing(null);
    setNotFound(false);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet, opDate, viewYesterday]);

  if (notFound) return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xs text-ink-soft">No closing found for {shortDate(opDate)}.</p>
      <button className="btn btn-ghost self-start" onClick={() => router.back()}>← Back</button>
    </div>
  );
  if (!closing) return <p className="font-mono text-xs text-ink-soft">Loading closing…</p>;

  const counted = closing.stock_counts.length;
  const onlineEntered = closing.sales_lines.filter((l) => l.source === "STAFF_ENTRY").length;
  const walkinLines = closing.sales_lines.filter((l) => l.source === "SYSTEM_DERIVED").length;
  const paid = closing.payments.length > 0;

  async function submit() {
    setBusy(true);
    try {
      const c = await api<DailyClosing>(`/daily-closings/${closing!.id}/submit/`, { method: "POST" });
      invalidateClosingCache(outlet, opDate);
      setClosing(c);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-xl font-bold">
            {viewYesterday ? "Yesterday's closing" : "Day-end closing"}
          </h1>
          <p className="text-xs text-ink-soft">{shortDate(opDate)}</p>
        </div>
        <Stamp status={closing.status} />
      </div>

      {!viewYesterday && (
        <div className="flex flex-col gap-2">
          <Step
            n={1}
            href="/staff/closing/count"
            title="Count remains & wastage"
            progress={`${counted}/${totalProducts} counted`}
            done={counted >= totalProducts && totalProducts > 0}
          />
          <Step
            n={2}
            href="/staff/closing/online"
            title="Online sell"
            progress={`${onlineEntered} line(s) entered`}
            done={onlineEntered > 0}
          />
          <Step
            n={3}
            href="/staff/closing/walkin"
            title="Sales summary"
            progress={`${walkinLines} derived line(s)`}
            done={walkinLines > 0}
          />
          <Step
            n={4}
            href="/staff/closing/payments"
            title="Payments"
            progress={paid ? "recorded" : "pending"}
            done={paid}
          />
        </div>
      )}

      {/* Stock summary link — informational, not a step */}
      {!viewYesterday && (
        <Link
          href="/staff/closing/stock"
          className="flex items-center justify-between rounded border border-dashed border-[#d8cdb0] bg-paper px-4 py-3 text-ink-soft hover:bg-paper-dim"
        >
          <div>
            <span className="block font-display text-sm font-bold text-ink">Stock summary</span>
            <span className="block font-mono text-[11px] text-ink-soft">
              Prepared items · beverages · raw ingredients
            </span>
          </div>
          <span className="font-mono text-ink-soft">›</span>
        </Link>
      )}

      {(() => {
        const onlineLines = closing.sales_lines.filter((l) => l.source === "STAFF_ENTRY");
        const onlineSell = onlineLines.reduce((s, l) => s + Number(l.gross_amount), 0);
        const walkinSell = closing.sales_lines
          .filter((l) => l.source === "SYSTEM_DERIVED")
          .reduce((s, l) => s + Number(l.gross_amount), 0);
        const totalGross = onlineSell + walkinSell;
        const nonCashPayments = closing.payments.filter(
          (p) => !p.is_primary_cash && Number(p.amount) > 0
        );
        return (
          <div className="ticket flex flex-col gap-0">
            <div className="ticket-row">
              <span>Revenue</span>
              <span className="qty font-semibold">{bdt(String(totalGross))}</span>
            </div>

            {onlineSell > 0 && (
              <div className="ticket-row text-ink-soft">
                <span className="pl-3 text-[11px]">Online sell</span>
                <span className="qty text-[11px]">{bdt(String(onlineSell))}</span>
              </div>
            )}

            {nonCashPayments.length > 0 && (
              <div className="my-1 border-t border-dashed border-[#d8cdb0]" />
            )}

            {nonCashPayments.map((p) => (
              <div key={p.id} className="ticket-row text-ink-soft">
                <span className="pl-3 text-[11px]">{p.account_name}</span>
                <span className="qty text-[11px]">{bdt(p.amount)}</span>
              </div>
            ))}

            <div className="ticket-row">
              <span>Cash (computed)</span>
              <span className="qty">{bdt(closing.computed_cash)}</span>
            </div>

            {closing.has_flag && (
              <p className="mt-2 font-mono text-[11px] text-chili-deep">
                ⚑ A stock count is flagged (walk-in derived below zero). Owner review required.
              </p>
            )}
          </div>
        );
      })()}

      {!viewYesterday && closing.status === "DRAFT" && (
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? "Submitting…" : "Submit closing"}
        </button>
      )}
      {!viewYesterday && closing.status === "SUBMITTED" && (
        <p className="font-mono text-xs text-gold-deep">Submitted — awaiting owner review (flagged).</p>
      )}
      {!viewYesterday && closing.status === "LOCKED" && (
        <p className="font-mono text-xs text-leaf-deep">Locked ✓ — closing complete.</p>
      )}
      <button className="btn btn-ghost" onClick={() => router.push("/staff")}>
        Back to home
      </button>
    </div>
  );
}

function Step({
  n,
  href,
  title,
  progress,
  done,
}: {
  n: number;
  href: string;
  title: string;
  progress: string;
  done: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded border px-4 py-3 ${
        done ? "border-leaf/40 bg-leaf/10" : "border-[#d8cdb0] bg-[#fffdf7]"
      }`}
    >
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full font-mono text-xs ${
          done ? "bg-leaf text-white" : "bg-paper-dim text-ink-soft"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className="flex-1">
        <span className="block font-display text-sm font-bold">{title}</span>
        <span className="block font-mono text-[11px] text-ink-soft">{progress}</span>
      </span>
      <span className="font-mono text-ink-soft">›</span>
    </Link>
  );
}
