"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing } from "@/lib/closing";
import { bdt, shortDate, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import { Stamp } from "@/components/Stamp";
import type { DailyClosing, Paginated, Product } from "@/lib/types";

export default function ClosingHub() {
  const { user } = useAuth();
  const router = useRouter();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [totalProducts, setTotalProducts] = useState(0);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const c = await getOrCreateTodayClosing(outlet, opDate);
    setClosing(c);
    const p = await api<Paginated<Product>>("/products/?active=true");
    setTotalProducts(p.results.filter((x) => x.product_type === "SINGLE").length);
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet, opDate]);

  if (!closing) return <p className="font-mono text-xs text-ink-soft">Loading closing…</p>;

  const counted = closing.stock_counts.length;
  const onlineEntered = closing.sales_lines.filter((l) => l.source === "STAFF_ENTRY").length;
  const walkinLines = closing.sales_lines.filter((l) => l.source === "SYSTEM_DERIVED").length;
  const paid = closing.payments.length > 0;

  async function submit() {
    setBusy(true);
    try {
      const c = await api<DailyClosing>(`/daily-closings/${closing!.id}/submit/`, { method: "POST" });
      setClosing(c);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-xl font-bold">Day-end closing</h1>
          <p className="text-xs text-ink-soft">{shortDate(opDate)}</p>
        </div>
        <Stamp status={closing.status} />
      </div>

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

      {/* Stock summary link — informational, not a step */}
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

      <div className="ticket">
        <div className="ticket-row">
          <span>Net revenue (after discount)</span>
          <span>{bdt(closing.channel_day_net_revenue)}</span>
        </div>
        <div className="ticket-row">
          <span>Computed cash</span>
          <span>{bdt(closing.computed_cash)}</span>
        </div>
        {closing.has_flag && (
          <p className="mt-2 font-mono text-[11px] text-chili-deep">
            ⚑ A stock count is flagged (walk-in derived below zero). Owner review required.
          </p>
        )}
      </div>

      {closing.status === "DRAFT" && (
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? "Submitting…" : "Submit closing"}
        </button>
      )}
      {closing.status === "SUBMITTED" && (
        <p className="font-mono text-xs text-gold-deep">Submitted — awaiting owner review (flagged).</p>
      )}
      {closing.status === "LOCKED" && (
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
