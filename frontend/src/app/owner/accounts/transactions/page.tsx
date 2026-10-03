"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate, today } from "@/lib/format";
import { BALANCE_COLOR } from "@/lib/accountTypes";
import type { AccountTransaction, FinancialAccount, Paginated } from "@/lib/types";

export default function AccountTransactionsPage() {
  const { isAdmin } = useAuth();
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);

  const [filterAccount, setFilterAccount] = useState("");
  const [filterFrom, setFilterFrom] = useState(today().slice(0, 8) + "01");
  const [filterTo, setFilterTo] = useState(today());
  const [txnDeleteConfirm, setTxnDeleteConfirm] = useState<number | null>(null);
  const [txnError, setTxnError] = useState<string | null>(null);

  async function loadAccounts() {
    const d = await api<Paginated<FinancialAccount>>("/financial-accounts/?is_active=all");
    setAccounts(d.results);
  }

  async function loadTransactions() {
    const params = new URLSearchParams({ date_from: filterFrom, date_to: filterTo });
    if (filterAccount) params.set("account", filterAccount);
    const d = await api<Paginated<AccountTransaction>>(`/account-transactions/?${params}&limit=100`);
    setTransactions(d.results);
  }

  async function deleteTransaction(id: number) {
    setTxnError(null);
    try {
      await api(`/account-transactions/${id}/`, { method: "DELETE" });
      setTxnDeleteConfirm(null);
      setTransactions((prev) => prev.filter((t) => t.id !== id));
      await loadAccounts();
    } catch {
      setTxnError("Could not delete transaction.");
      setTxnDeleteConfirm(null);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    loadTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterFrom, filterTo, filterAccount]);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/owner/accounts" className="self-start font-mono text-[11px] text-ink-soft">
        ‹ Back to Accounts
      </Link>

      <div>
        <h1 className="font-display text-xl font-bold">Transaction log</h1>
        <p className="text-xs text-ink-soft">Every posted transaction across all accounts</p>
      </div>

      <div className="filterbar flex-wrap">
        <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
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

      {txnError && <p className="font-mono text-[11px] text-chili-deep">{txnError}</p>}
      <div className="overflow-x-auto">
        <table className="datatable min-w-[640px]">
          <thead>
            <tr>
              <th>Date</th>
              <th>Account</th>
              <th>Type</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Before</th>
              <th className="text-right">After</th>
              <th>Note</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => {
              const amt = Number(t.amount);
              return (
                <tr key={t.id}>
                  <td>{shortDate(t.date)}</td>
                  <td className="text-ink-soft">{t.account_name}</td>
                  <td>
                    <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
                      amt >= 0
                        ? "bg-leaf/10 text-leaf-deep"
                        : "bg-chili/10 text-chili-deep"
                    }`}>
                      {t.transaction_type_display}
                    </span>
                  </td>
                  <td className={`text-right font-mono font-semibold ${
                    amt >= 0 ? "text-leaf-deep" : "text-chili-deep"
                  }`}>
                    {amt >= 0 ? "+" : ""}{bdt(amt)}
                  </td>
                  <td className={`text-right font-mono ${BALANCE_COLOR(Number(t.balance_before))}`}>
                    {bdt(t.balance_before)}
                  </td>
                  <td className={`text-right font-mono font-semibold ${BALANCE_COLOR(Number(t.balance_after))}`}>
                    {bdt(t.balance_after)}
                  </td>
                  <td className="text-ink-soft text-xs">{t.note || "—"}</td>
                  {isAdmin && (
                    <td>
                      {txnDeleteConfirm === t.id ? (
                        <span className="flex items-center gap-1">
                          <button
                            className="font-mono text-[10px] text-chili-deep font-bold"
                            onClick={() => deleteTransaction(t.id)}
                          >Confirm</button>
                          <button
                            className="font-mono text-[10px] text-ink-soft"
                            onClick={() => setTxnDeleteConfirm(null)}
                          >Cancel</button>
                        </span>
                      ) : (
                        <button
                          className="font-mono text-[11px] text-chili opacity-40 hover:opacity-100"
                          onClick={() => setTxnDeleteConfirm(t.id)}
                        >✕</button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {transactions.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 8 : 7} className="text-ink-soft">No transactions in this period.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
