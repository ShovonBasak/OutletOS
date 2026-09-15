"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate, today } from "@/lib/format";
import type { AccountTransaction, FinancialAccount, Paginated } from "@/lib/types";

const BALANCE_COLOR = (n: number) =>
  n < 0 ? "text-chili-deep" : n > 0 ? "text-leaf-deep" : "text-ink";

export default function AccountStatementPage() {
  const { id } = useParams<{ id: string }>();
  const { isOwnerOrAdmin } = useAuth();

  const [account, setAccount] = useState<FinancialAccount | null>(null);
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filterFrom, setFilterFrom] = useState(today().slice(0, 8) + "01");
  const [filterTo, setFilterTo] = useState(today());
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [recalcMsg, setRecalcMsg] = useState<string | null>(null);

  async function load() {
    const [acct, txns] = await Promise.all([
      api<FinancialAccount>(`/financial-accounts/${id}/`),
      api<Paginated<AccountTransaction>>(
        `/account-transactions/?account=${id}&date_from=${filterFrom}&date_to=${filterTo}&limit=500`
      ),
    ]);
    setAccount(acct);
    // API returns newest-first; a statement reads oldest-first, running down to the latest.
    setTransactions([...txns.results].reverse());
    setLoaded(true);
  }

  useEffect(() => {
    setLoaded(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, filterFrom, filterTo]);

  async function recalculate() {
    setRecalcBusy(true);
    setRecalcMsg(null);
    try {
      const result = await api<{ checked: number; changed: number }>(
        `/financial-accounts/${id}/recompute-balances/`,
        { method: "POST" }
      );
      setRecalcMsg(
        result.changed === 0
          ? `Checked ${result.checked} transaction(s) — already correct.`
          : `Checked ${result.checked} transaction(s) — corrected ${result.changed}.`
      );
      await load();
    } finally {
      setRecalcBusy(false);
    }
  }

  if (!loaded || !account) {
    return <p className="font-mono text-xs text-ink-soft">Loading…</p>;
  }

  const currentBalance = Number(account.current_balance);
  const openingForWindow = transactions.length > 0
    ? Number(transactions[0].balance_before)
    : currentBalance;
  const openingLabel = transactions.length > 0 ? shortDate(transactions[0].date) : shortDate(filterFrom);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/owner/accounts" className="font-mono text-[11px] text-ink-soft hover:underline self-start">
        ← All accounts
      </Link>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-xl font-bold flex items-center gap-2">
            {account.name}
            {account.is_primary_cash && (
              <span className="rounded bg-chrome/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-chrome">
                primary cash
              </span>
            )}
          </h1>
          <p className="text-xs text-ink-soft">
            {account.account_type_display}{account.provider ? ` · ${account.provider}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Current balance</p>
          <p className={`font-mono text-2xl font-bold ${BALANCE_COLOR(currentBalance)}`}>
            {bdt(currentBalance)}
          </p>
        </div>
      </div>

      {isOwnerOrAdmin && (
        <div className="flex items-center gap-2 self-end">
          {recalcMsg && <span className="font-mono text-[10px] text-ink-soft">{recalcMsg}</span>}
          <button
            className="btn btn-ghost flex items-center gap-1.5 !py-1 !px-2.5 text-[11px]"
            disabled={recalcBusy}
            onClick={recalculate}
            title="Recompute this account's running balance from opening_balance forward"
          >
            <svg
              className={`h-3.5 w-3.5 ${recalcBusy ? "animate-spin" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 0 1 15.4-6.4M21 12a9 9 0 0 1-15.4 6.4" />
              <path d="M18 3v4.5h-4.5M6 21v-4.5h4.5" />
            </svg>
            {recalcBusy ? "Recalculating…" : "Recalculate balances"}
          </button>
        </div>
      )}

      <div className="filterbar flex-wrap">
        <label className="flex items-center gap-1 font-mono text-[11px] text-ink-soft">
          From
          <input
            type="date"
            className="field-input !py-1 !text-[11px]"
            value={filterFrom}
            max={filterTo}
            onChange={(e) => setFilterFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1 font-mono text-[11px] text-ink-soft">
          To
          <input
            type="date"
            className="field-input !py-1 !text-[11px]"
            value={filterTo}
            min={filterFrom}
            onChange={(e) => setFilterTo(e.target.value)}
          />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[720px]">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Note</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-paper-dim/40">
              <td>{openingLabel}</td>
              <td className="text-ink-soft italic">Opening balance</td>
              <td className="text-ink-soft text-xs">—</td>
              <td className="text-right font-mono text-ink-soft">—</td>
              <td className="text-right font-mono text-ink-soft">—</td>
              <td className={`text-right font-mono font-semibold ${BALANCE_COLOR(openingForWindow)}`}>
                {bdt(openingForWindow)}
              </td>
            </tr>
            {transactions.map((t) => {
              const amt = Number(t.amount);
              return (
                <tr key={t.id}>
                  <td>{shortDate(t.date)}</td>
                  <td>
                    <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
                      amt >= 0 ? "bg-leaf/10 text-leaf-deep" : "bg-chili/10 text-chili-deep"
                    }`}>
                      {t.transaction_type_display}
                    </span>
                  </td>
                  <td className="text-ink-soft text-xs">{t.note || "—"}</td>
                  <td className="text-right font-mono text-chili-deep">
                    {amt < 0 ? bdt(Math.abs(amt)) : "—"}
                  </td>
                  <td className="text-right font-mono text-leaf-deep">
                    {amt > 0 ? bdt(amt) : "—"}
                  </td>
                  <td className={`text-right font-mono font-semibold ${BALANCE_COLOR(Number(t.balance_after))}`}>
                    {bdt(t.balance_after)}
                  </td>
                </tr>
              );
            })}
            {transactions.length === 0 && (
              <tr>
                <td colSpan={6} className="text-ink-soft">No transactions in this period.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
