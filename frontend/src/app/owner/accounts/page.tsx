"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { bdt, shortDate } from "@/lib/format";
import { ACCOUNT_TYPE_COLOR, ACCOUNT_TYPE_ICON, ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER, BALANCE_COLOR } from "@/lib/accountTypes";
import { MoveMoneySheet } from "@/components/MoveMoneySheet";
import { Snackbar } from "@/components/Snackbar";
import type { AccountTransaction, AccountType, FinancialAccount, Paginated } from "@/lib/types";

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [recent, setRecent] = useState<AccountTransaction[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Single global toggle, not per-category — tapping the total balance
  // reveals every account's own balance underneath it. Mobile-only: on
  // `sm:` and up the cards always show regardless of this.
  const [accountsExpanded, setAccountsExpanded] = useState(false);

  async function loadAccounts() {
    const d = await api<Paginated<FinancialAccount>>("/financial-accounts/?is_active=all");
    setAccounts(d.results);
  }

  async function loadRecent() {
    const d = await api<Paginated<AccountTransaction>>("/account-transactions/?limit=8");
    setRecent(d.results);
  }

  useEffect(() => {
    loadAccounts();
    loadRecent();
  }, []);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.is_active), [accounts]);
  const totalBalance = useMemo(
    () => activeAccounts.reduce((s, a) => s + Number(a.current_balance), 0),
    [activeAccounts]
  );

  function showToast(text: string) {
    setToast(null);
    setTimeout(() => setToast(text), 50);
  }

  function handleMoveDone(message: string) {
    showToast(message);
    loadAccounts();
    loadRecent();
  }

  return (
    <div className="flex flex-col gap-6">

      {/* ── Hero: total balance — tap to expand/collapse every account below ── */}
      <button type="button" onClick={() => setAccountsExpanded((v) => !v)} className="ticket w-full text-left">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Total across all accounts</p>
        <p className={`mt-1.5 font-display text-[34px] font-bold leading-none ${BALANCE_COLOR(totalBalance)}`}>
          {bdt(totalBalance)}
        </p>
        <p className="mt-2 font-mono text-[11px] text-ink-soft">
          {activeAccounts.length} active account{activeAccounts.length === 1 ? "" : "s"}
        </p>
        {/* A clearly separate, colored, chevron-led row reads as a control —
            the earlier small grey inline hint didn't look clickable at all. */}
        <div className="mt-3 flex items-center gap-1.5 border-t border-dotted border-[#d8cdb0] pt-2.5 font-mono text-[11px] font-semibold text-chrome-soft sm:hidden">
          <span>{accountsExpanded ? "Hide accounts" : "Show accounts"}</span>
          <span className="text-[13px] leading-none">{accountsExpanded ? "▴" : "▾"}</span>
        </div>
      </button>

      {/* ── Account cards grouped by type — one global expand/collapse on mobile ── */}
      <section className="flex flex-col gap-4">
        {ACCOUNT_TYPE_ORDER.map((type) => (
          <CategorySection
            key={type}
            type={type}
            accounts={activeAccounts.filter((a) => a.account_type === type)}
            open={accountsExpanded}
          />
        ))}
        <Link
          href="/owner/accounts/manage"
          className="flex items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-[#d8cdb0] py-3 text-ink-soft transition hover:border-chrome-soft hover:text-chrome-soft"
        >
          <span className="text-base leading-none">+</span>
          <span className="font-mono text-[11px]">Add account</span>
        </Link>
      </section>

      {/* ── Quick actions ── */}
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-ink-soft/60">Quick actions</h2>
        <div className="grid grid-cols-2 gap-3">
          {/* text-left overrides the browser's default centered text-align
              on <button> — without it, this tile's content centers while
              the <Link> tile below (an <a>, no such default) stays left,
              making the two look asymmetrical despite identical classes. */}
          <button onClick={() => setSheetOpen(true)} className="tile text-left">
            <span className="n">💰↔️</span>
            <span className="l">Move money</span>
          </button>
          <Link href="/owner/accounts/manage" className="tile text-left">
            <span className="n">🗂️</span>
            <span className="l">Manage</span>
          </Link>
        </div>
      </section>

      {/* ── Recent activity ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-ink-soft/60">Recent activity</h2>
          <Link href="/owner/accounts/transactions" className="font-mono text-[11px] text-chrome-soft hover:underline">
            View all →
          </Link>
        </div>
        <div className="flex flex-col rounded-lg border border-[#d8cdb0] bg-[#fffdf7] overflow-hidden">
          {recent.map((t) => {
            const amt = Number(t.amount);
            return (
              <div key={t.id} className="flex items-center gap-3 border-b border-dotted border-[#e8dfc8] px-4 py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[12.5px] text-ink">{t.transaction_type_display} · {t.account_name}</p>
                  <p className="mt-0.5 font-mono text-[10.5px] text-ink-soft">{shortDate(t.date)}</p>
                </div>
                <p className={`shrink-0 font-mono text-[13px] font-semibold ${amt >= 0 ? "text-leaf-deep" : "text-chili-deep"}`}>
                  {amt >= 0 ? "+" : ""}{bdt(amt)}
                </p>
              </div>
            );
          })}
          {recent.length === 0 && (
            <p className="px-4 py-6 text-center font-mono text-xs text-ink-soft">No activity yet.</p>
          )}
        </div>
      </section>

      <MoveMoneySheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        accounts={accounts}
        onDone={handleMoveDone}
      />
      {toast && <Snackbar key={toast + Date.now()} text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

// Grouped by account type, like before. `open` is one shared toggle owned
// by the page (driven by tapping the total-balance hero), not a per-category
// state — collapsing categories independently was confusing. When closed on
// mobile the whole section hides, header included — a category label with
// nothing under it just looked broken. Desktop (`sm:` and up) always shows
// everything regardless of `open`.
function CategorySection({ type, accounts, open }: { type: AccountType; accounts: FinancialAccount[]; open: boolean }) {
  if (accounts.length === 0) return null;

  return (
    <div className={`${open ? "flex" : "hidden"} sm:flex flex-col gap-2`}>
      <h3 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-ink-soft">
        <span>{ACCOUNT_TYPE_ICON[type]}</span>
        <span>{ACCOUNT_TYPE_LABELS[type]}</span>
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {accounts.map((a) => {
          const bal = Number(a.current_balance);
          return (
            <Link
              key={a.id}
              href={`/owner/accounts/${a.id}`}
              className={`rounded-lg border-2 px-4 py-3 flex flex-col gap-1 hover:brightness-95 transition ${ACCOUNT_TYPE_COLOR[a.account_type] ?? "border-[#d8cdb0]"}`}
            >
              <div className="flex items-center gap-2">
                <span className="font-display text-[15px] font-bold text-ink">{a.name}</span>
                {a.is_primary_cash && (
                  <span className="rounded bg-chrome/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-chrome">
                    primary
                  </span>
                )}
                {a.provider && (
                  <span className="ml-auto font-mono text-[10px] text-ink-soft">{a.provider}</span>
                )}
              </div>
              <div className={`font-mono text-[22px] font-bold ${BALANCE_COLOR(bal)}`}>
                {bdt(bal)}
              </div>
              <div className="font-mono text-[10px] text-ink-soft">
                Opening {bdt(a.opening_balance)} · from {shortDate(a.opening_balance_date)}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
