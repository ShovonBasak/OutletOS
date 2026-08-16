"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate } from "@/lib/format";

interface Transaction {
  id: number;
  transaction_type: string;
  transaction_type_display: string;
  amount: string;
  date: string;
  source_type: string;
  note: string;
}

interface HistoryResponse {
  cash: { id: number; name: string; balance: string };
  transactions: {
    count: number;
    page: number;
    page_size: number;
    total_pages: number;
    results: Transaction[];
  };
  accounts: { id: number; name: string; account_type: string }[];
}

const TYPE_LABELS: Record<string, string> = {
  SALES_COLLECTION: "Sales collection",
  EXPENSE_PAYMENT: "Expense payment",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  CAPITAL_INJECTION: "Capital injection",
  OWNER_WITHDRAWAL: "Owner withdrawal",
  ADJUSTMENT: "Adjustment",
  SUPPLIER_ORDER_DEDUCTION: "Stock payment",
  OTHER_INCOME: "Other income",
};

// Positive amount = credit (green), negative = debit (chili)
function amtColor(amount: string) {
  return Number(amount) >= 0 ? "text-leaf-deep" : "text-chili";
}

function fmtAmount(amount: string) {
  const n = Number(amount);
  return (n >= 0 ? "+" : "") + bdt(String(Math.abs(n)));
}

function groupByDate(txns: Transaction[]) {
  const groups: { date: string; items: Transaction[] }[] = [];
  let cur: (typeof groups)[0] | null = null;
  for (const t of txns) {
    if (!cur || cur.date !== t.date) {
      cur = { date: t.date, items: [] };
      groups.push(cur);
    }
    cur.items.push(t);
  }
  return groups;
}

export default function CashHistoryPage() {
  const { user } = useAuth();

  const [cashName, setCashName] = useState("Shop Cash");
  const [balance, setBalance] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // Transfer form
  const [transferOpen, setTransferOpen] = useState(false);
  const [toAccount, setToAccount] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [transferMsg, setTransferMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const toAccountSet = useRef(false);
  const prevCtx = useRef({ userId: 0, page: 0, refresh: 0 });

  useEffect(() => {
    if (!user) return;
    const ctx = { userId: user.id, page, refresh: refreshKey };
    const p = prevCtx.current;
    if (p.userId === ctx.userId && p.page === ctx.page && p.refresh === ctx.refresh) return;
    prevCtx.current = ctx;

    setLoaded(false);
    api<HistoryResponse>(`/cash/history/?page=${page}`)
      .then((h) => {
        setBalance(h.cash.balance);
        setCashName(h.cash.name);
        setAccounts(h.accounts.map((a) => ({ id: a.id, name: a.name })));
        if (!toAccountSet.current && h.accounts[0]) {
          setToAccount(String(h.accounts[0].id));
          toAccountSet.current = true;
        }
        setTransactions(h.transactions.results);
        setTotalPages(h.transactions.total_pages);
        setTotalCount(h.transactions.count);
      })
      .finally(() => setLoaded(true));
  }, [user, page, refreshKey]);

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    setTransferMsg(null);
    setTransferring(true);
    try {
      const res = await api<{ detail: string; new_cash_balance: string }>("/cash/", {
        method: "POST",
        body: JSON.stringify({
          to_account: Number(toAccount),
          amount: transferAmount,
          note: transferNote,
        }),
      });
      setBalance(res.new_cash_balance);
      setTransferMsg({ ok: true, text: "Transfer recorded." });
      setTransferAmount("");
      setTransferNote("");
      // Reset to page 1 and reload transaction list
      setPage(1);
      setRefreshKey((k) => k + 1);
    } catch (err: unknown) {
      const body = (err as { body?: { error?: string } })?.body;
      setTransferMsg({ ok: false, text: body?.error ?? "Transfer failed." });
    } finally {
      setTransferring(false);
    }
  }

  const groups = groupByDate(transactions);

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/staff" className="font-mono text-sm text-ink-soft">‹</Link>
        <h1 className="font-display text-xl font-bold">{cashName}</h1>
      </div>

      {/* Balance card — dark brand style */}
      <div className="relative overflow-hidden rounded-2xl bg-[#241512] px-6 py-5 shadow-lg">
        {/* Subtle decorative ring */}
        <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full border border-paper/5" />
        <div className="pointer-events-none absolute -right-3 -top-3 h-20 w-20 rounded-full border border-paper/5" />

        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-paper/40">
          Current balance
        </p>
        <p className="mt-2 font-mono text-4xl font-bold tracking-tight text-paper">
          {balance !== null ? bdt(balance) : "—"}
        </p>

        <div className="mt-5 flex items-center justify-between">
          <p className="font-mono text-[10px] text-paper/30">
            {totalCount > 0 ? `${totalCount} transactions` : "No transactions yet"}
          </p>
          <button
            onClick={() => {
              setTransferOpen((v) => !v);
              setTransferMsg(null);
            }}
            className="rounded-full border border-paper/20 px-4 py-1.5 font-mono text-[11px] text-paper/80 transition-colors active:bg-paper/10"
          >
            {transferOpen ? "Cancel" : "Transfer →"}
          </button>
        </div>
      </div>

      {/* Transfer form — inline expand */}
      {transferOpen && (
        <div className="rounded-xl border border-[#d8cdb0] bg-[#fffdf7] p-4">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
            Transfer cash out
          </p>
          <form onSubmit={handleTransfer} className="flex flex-col gap-3">
            <div className="field">
              <span className="field-label">Transfer to</span>
              <select
                value={toAccount}
                onChange={(e) => setToAccount(e.target.value)}
                className="field-input w-full"
                required
              >
                {accounts.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <label className="field">
              <span className="field-label">Amount (৳)</span>
              <input
                className="field-input"
                type="number"
                inputMode="decimal"
                min="1"
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
              <p
                className={`font-mono text-xs ${transferMsg.ok ? "text-leaf-deep" : "text-chili-deep"}`}
              >
                {transferMsg.text}
              </p>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={transferring || !toAccount || !transferAmount}
            >
              {transferring ? "Transferring…" : "Confirm transfer"}
            </button>
          </form>
        </div>
      )}

      {/* Transaction history */}
      <div className="flex flex-col gap-1">
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">
          Transaction history
        </p>
      </div>

      {!loaded && (
        <p className="font-mono text-xs text-ink-soft">Loading…</p>
      )}
      {loaded && transactions.length === 0 && (
        <p className="font-mono text-xs text-ink-soft">No transactions recorded yet.</p>
      )}

      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <div key={group.date}>
            {/* Date section header */}
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                {shortDate(group.date)}
              </span>
              <div className="h-px flex-1 bg-[#e0d8c0]" />
            </div>

            <div className="flex flex-col gap-1.5">
              {group.items.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 rounded-xl border border-[#e0d8c0] bg-[#fffdf7] px-4 py-3"
                >
                  {/* Type indicator dot */}
                  <div
                    className={`h-2 w-2 shrink-0 rounded-full ${Number(t.amount) >= 0 ? "bg-leaf" : "bg-chili"}`}
                  />

                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs font-semibold text-ink">
                      {TYPE_LABELS[t.transaction_type] ?? t.transaction_type_display}
                    </p>
                    {t.note && (
                      <p className="truncate font-mono text-[10px] text-ink-soft">{t.note}</p>
                    )}
                  </div>

                  <p
                    className={`shrink-0 font-mono text-sm font-bold tabular-nums ${amtColor(t.amount)}`}
                  >
                    {fmtAmount(t.amount)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-[#e0d8c0] pt-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || !loaded}
            className="font-mono text-xs text-ink-soft disabled:opacity-30"
          >
            ‹ Prev
          </button>
          <p className="font-mono text-[10px] text-ink-soft">
            Page {page} of {totalPages}
          </p>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages || !loaded}
            className="font-mono text-xs text-ink-soft disabled:opacity-30"
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
