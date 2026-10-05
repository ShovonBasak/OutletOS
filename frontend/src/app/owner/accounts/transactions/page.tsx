"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate, today } from "@/lib/format";
import { BALANCE_COLOR, transactionHeadline, transferCustomNote } from "@/lib/accountTypes";
import AccountPicker from "@/components/AccountPicker";
import SearchablePicker from "@/components/SearchablePicker";
import { BottomSheet } from "@/components/BottomSheet";
import TransactionCard from "@/components/TransactionCard";
import type { AccountTransaction, FinancialAccount, Paginated, TransactionType } from "@/lib/types";

const TRANSACTION_TYPE_OPTIONS: { id: TransactionType; name: string }[] = [
  { id: "SALES_COLLECTION", name: "Sales Collection" },
  { id: "EXPENSE_PAYMENT", name: "Expense Payment" },
  { id: "TRANSFER_IN", name: "Transfer In" },
  { id: "TRANSFER_OUT", name: "Transfer Out" },
  { id: "CAPITAL_INJECTION", name: "Capital Injection" },
  { id: "OWNER_WITHDRAWAL", name: "Owner Withdrawal" },
  { id: "ADJUSTMENT", name: "Adjustment" },
  { id: "SUPPLIER_ORDER_DEDUCTION", name: "Supplier Order Deduction" },
  { id: "OTHER_INCOME", name: "Other Income" },
];

export default function AccountTransactionsPage() {
  const { isAdmin } = useAuth();
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);

  const [filterFrom, setFilterFrom] = useState(today().slice(0, 8) + "01");
  const [filterTo, setFilterTo] = useState(today());

  // Account/type filters live behind a "Filters" sheet instead of sitting
  // inline by default — same pattern as the Expenses page.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterAccount, setFilterAccount] = useState("");
  const [filterType, setFilterType] = useState("");

  const [txnDeleteConfirm, setTxnDeleteConfirm] = useState<number | null>(null);
  const [txnError, setTxnError] = useState<string | null>(null);

  async function loadAccounts() {
    const d = await api<Paginated<FinancialAccount>>("/financial-accounts/?is_active=all");
    setAccounts(d.results);
  }

  async function loadTransactions() {
    const params = new URLSearchParams({ date_from: filterFrom, date_to: filterTo });
    if (filterAccount) params.set("account", filterAccount);
    if (filterType) params.set("transaction_type", filterType);
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
  }, [filterFrom, filterTo, filterAccount, filterType]);

  const accountFilterName = accounts.find((a) => String(a.id) === filterAccount)?.name;
  const typeFilterName = TRANSACTION_TYPE_OPTIONS.find((t) => t.id === filterType)?.name;
  const activeFilterCount = [filterAccount, filterType].filter(Boolean).length;

  function clearAllFilters() {
    setFilterAccount(""); setFilterType("");
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/owner/accounts" className="self-start font-mono text-[11px] text-ink-soft">
        ‹ Back to Accounts
      </Link>

      <div>
        <h1 className="font-display text-xl font-bold">Transaction log</h1>
        <p className="text-xs text-ink-soft">Every posted transaction across all accounts</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="field flex-1 min-w-[140px]">
          <span className="field-label">From</span>
          <input
            type="date"
            className="field-input"
            value={filterFrom}
            max={filterTo}
            onChange={(e) => setFilterFrom(e.target.value)}
          />
        </label>
        <label className="field flex-1 min-w-[140px]">
          <span className="field-label">To</span>
          <input
            type="date"
            className="field-input"
            value={filterTo}
            min={filterFrom}
            onChange={(e) => setFilterTo(e.target.value)}
          />
        </label>
      </div>

      {/* filters — one trigger instead of dropdowns sitting inline; active
          picks show as removable chips underneath. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setFiltersOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-[#d8cdb0] bg-[#fffdf7] px-3 py-1.5 font-mono text-[11px] text-ink-soft hover:border-chrome-soft hover:text-chrome-soft"
        >
          <span>⚙ Filters</span>
          {activeFilterCount > 0 && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-chrome font-mono text-[9px] font-bold text-paper">
              {activeFilterCount}
            </span>
          )}
        </button>
        {accountFilterName && (
          <FilterChip label={accountFilterName} onClear={() => setFilterAccount("")} />
        )}
        {typeFilterName && (
          <FilterChip label={typeFilterName} onClear={() => setFilterType("")} />
        )}
        {activeFilterCount > 0 && (
          <button onClick={clearAllFilters} className="font-mono text-[10px] text-ink-soft underline">
            Clear all
          </button>
        )}
      </div>

      {txnError && <p className="font-mono text-[11px] text-chili-deep">{txnError}</p>}

      {/* Mobile: one card per transaction — the table needs horizontal
          scroll to see every column, which doesn't work well on a phone. */}
      <div className="flex flex-col gap-2.5 sm:hidden">
        {transactions.map((t) => (
          <TransactionCard
            key={t.id}
            t={t}
            deleteConfirm={isAdmin && txnDeleteConfirm === t.id}
            onDeleteClick={isAdmin ? () => setTxnDeleteConfirm(t.id) : undefined}
            onConfirmDelete={() => deleteTransaction(t.id)}
            onCancelDelete={() => setTxnDeleteConfirm(null)}
          />
        ))}
        {transactions.length === 0 && (
          <p className="py-6 text-center font-mono text-xs text-ink-soft">No transactions in this period.</p>
        )}
      </div>

      {/* Desktop/tablet: full table. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="datatable min-w-[700px]">
          <thead>
            <tr>
              <th>Date</th>
              <th>Account</th>
              <th>Type</th>
              <th>Activity</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Before</th>
              <th className="text-right">After</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => {
              const amt = Number(t.amount);
              const { headline, isTransfer } = transactionHeadline(t);
              const note = isTransfer ? transferCustomNote(t) : null;
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
                  <td className="text-ink-soft text-xs">
                    <p>{headline}</p>
                    {note && <p className="mt-0.5 text-ink-soft/70">{note}</p>}
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

      {/* ── filters sheet ── */}
      <BottomSheet open={filtersOpen} onClose={() => setFiltersOpen(false)}>
        <div className="flex flex-col gap-4 px-5 pb-6">
          <div className="flex items-center justify-between">
            <p className="font-display text-[16px] font-bold text-ink">Filters</p>
            {activeFilterCount > 0 && (
              <button onClick={clearAllFilters} className="font-mono text-[11px] text-chili-deep">
                Clear all
              </button>
            )}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Account</span>
            <AccountPicker
              accounts={accounts}
              value={filterAccount}
              onChange={setFilterAccount}
              placeholder="All accounts"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Transaction type</span>
            <SearchablePicker
              options={TRANSACTION_TYPE_OPTIONS}
              value={filterType}
              onChange={setFilterType}
              placeholder="All types"
            />
          </label>
          <button className="btn btn-primary" onClick={() => setFiltersOpen(false)}>Done</button>
        </div>
      </BottomSheet>
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-chrome-soft bg-chrome-soft/10 px-2.5 py-1 font-mono text-[10.5px] text-chrome-soft">
      {label}
      <button onClick={onClear} className="leading-none opacity-70 hover:opacity-100" aria-label={`Remove ${label} filter`}>
        ✕
      </button>
    </span>
  );
}
