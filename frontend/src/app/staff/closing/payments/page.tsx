"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getOrCreateTodayClosing, invalidateClosingCache } from "@/lib/closing";
import { bdt2, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type { DailyClosing, FinancialAccountName, Paginated } from "@/lib/types";

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  CASH: "Cash",
  MOBILE_WALLET: "Mobile Wallet",
  BANK: "Bank",
  SUPPLIER_CREDIT: "Supplier Credit",
};

export default function PaymentsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();

  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [accounts, setAccounts] = useState<FinancialAccountName[]>([]);
  // Map: accountId → entered amount string
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const prevCtx = useRef({ outlet: 0, opDate: "" });

  // Accounts the staff can manually enter (non-primary-cash, non-supplier-credit)
  const payableAccounts = useMemo(
    () => accounts.filter((a) => a.is_active && !a.is_primary_cash && a.account_type !== "SUPPLIER_CREDIT"),
    [accounts]
  );

  const cashAccount = useMemo(
    () => accounts.find((a) => a.is_primary_cash) ?? null,
    [accounts]
  );

  // Computed cash = offline sales − sum of entered amounts
  const computedCash = useMemo(() => {
    if (!closing) return 0;
    const offlineSales = parseFloat(closing.total_offline_sales) || 0;
    const typed = payableAccounts.reduce((sum, a) => {
      return sum + (parseFloat(amounts[a.id] || "0") || 0);
    }, 0);
    return offlineSales - typed;
  }, [closing, payableAccounts, amounts]);

  useEffect(() => {
    if (prevCtx.current.outlet === outlet && prevCtx.current.opDate === opDate) return;
    prevCtx.current = { outlet, opDate };
    async function load() {
      const [c, acc] = await Promise.all([
        getOrCreateTodayClosing(outlet, opDate),
        api<Paginated<FinancialAccountName>>("/financial-accounts/"),
      ]);
      setClosing(c);
      setAccounts(acc.results);
      // Pre-fill from existing payment entries
      const init: Record<number, string> = {};
      for (const p of c.payments) {
        if (!p.is_primary_cash) {
          init[p.account] = String(p.amount);
        }
      }
      setAmounts(init);
    }
    load();
  }, [outlet, opDate]);

  async function save() {
    if (!closing) return;
    setBusy(true);
    try {
      const entries = payableAccounts.map((a) => ({
        account_id: a.id,
        amount: parseFloat(amounts[a.id] || "0") || 0,
      }));
      const updated = await api<DailyClosing>(`/daily-closings/${closing.id}/payments/`, {
        method: "POST",
        body: JSON.stringify({ entries }),
      });
      invalidateClosingCache(outlet, opDate);
      setClosing(updated);
    } finally {
      setBusy(false);
    }
  }

  function handleBlur() {
    save();
  }

  if (!closing) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  const cashEntry = closing.payments.find((p) => p.is_primary_cash);
  const displayCash = cashEntry ? parseFloat(cashEntry.amount) : computedCash;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Payments</h1>
        <p className="text-xs text-ink-soft">Step 4 · cash is computed automatically</p>
      </div>

      {/* Revenue summary */}
      <div className="ticket">
        <div className="ticket-row">
          <span>Total sale (all channels)</span>
          <span>{bdt2(closing.total_sale)}</span>
        </div>
        <div className="ticket-row">
          <span>− Online (direct to account)</span>
          <span>{bdt2(closing.online_payments)}</span>
        </div>
        <div className="ticket-total">
          <span>Total offline sales</span>
          <span>{bdt2(closing.total_offline_sales)}</span>
        </div>
      </div>

      {/* Per-account amount entries */}
      {payableAccounts.length === 0 ? (
        <p className="font-mono text-[11px] text-ink-soft">
          No payment accounts configured. Add mobile wallets or bank accounts in Owner → Accounts.
        </p>
      ) : (
        <div className="flex flex-col gap-0 rounded border border-[#d8cdb0]">
          {payableAccounts.map((a, idx) => (
            <label
              key={a.id}
              className={`flex items-center gap-3 px-3 py-2.5 ${
                idx < payableAccounts.length - 1 ? "border-b border-dotted border-[#e8e0cc]" : ""
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[13px] text-ink font-medium">{a.name}</p>
                <p className="font-mono text-[10px] text-ink-soft uppercase tracking-wide">
                  {ACCOUNT_TYPE_LABEL[a.account_type] ?? a.account_type}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <span className="font-mono text-[11px] text-ink-soft">৳</span>
                <input
                  className="field-input w-28 text-right font-mono"
                  inputMode="decimal"
                  value={amounts[a.id] ?? "0"}
                  onChange={(e) =>
                    setAmounts((prev) => ({ ...prev, [a.id]: e.target.value }))
                  }
                  onBlur={handleBlur}
                  onFocus={(e) => {
                    if (e.target.value === "0") {
                      setAmounts((prev) => ({ ...prev, [a.id]: "" }));
                    }
                  }}
                />
              </div>
            </label>
          ))}
        </div>
      )}

      {/* Computed cash */}
      <div className="rounded bg-action px-4 py-3 text-gold">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wide">
              {cashAccount ? cashAccount.name : "Shop Cash"}
              <span className="ml-1.5 font-normal normal-case text-gold/60">(computed)</span>
            </p>
          </div>
          <span className="num text-lg font-semibold">{bdt2(displayCash)}</span>
        </div>
        <p className="mt-1 font-mono text-[10px] text-gold/70">
          = offline sales − {payableAccounts.length > 0 ? payableAccounts.map((a) => a.name).join(" − ") : "other accounts"}
        </p>
        {displayCash < 0 && (
          <p className="mt-1 font-mono text-[10px] text-chili font-semibold">
            ⚠ Negative cash — entered amounts exceed offline sales
          </p>
        )}
      </div>

      <button
        className="btn btn-ghost"
        disabled={busy}
        onClick={async () => {
          await save();
          router.push("/staff/closing");
        }}
      >
        {busy ? "Saving…" : "Save & back to checklist"}
      </button>
    </div>
  );
}
